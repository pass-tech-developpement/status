#!/usr/bin/env node
/**
 * Relevé de disponibilité des services Pass Tech.
 *
 * Pour chaque cible de `targets.json` : une requête HTTP, une lecture du
 * certificat TLS, puis mise à jour de `data/history/<id>.json` (points bruts
 * bornés, agrégat quotidien, incidents) et recomposition de `data/status.json`,
 * seul fichier lu par la page.
 *
 * La sonde tourne sur l'infrastructure GitHub, extérieure aux serveurs
 * surveillés : c'est ce qui lui permet de constater une panne que la
 * supervision hébergée chez l'hébergeur ne peut pas signaler elle-même.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(RACINE, 'data');
const HISTORIQUE = join(DATA, 'history');

/** Points bruts conservés : 30 jours à 5 minutes. Au-delà, l'agrégat quotidien prend le relais. */
const JOURS_BRUTS = 30;
/** Jours gardés dans l'agrégat quotidien (la bande en affiche 90). */
const JOURS_AGREGAT = 400;
const INCIDENTS_MAX = 20;
const AGENT = 'passtech-status/1.0 (+https://github.com/pass-tech-developpement/status)';

const MS_JOUR = 86_400_000;
const maintenant = new Date();

/** Sonde HTTP. Un code hors de la plage attendue est une indisponibilité, pas une erreur technique. */
async function sonder(cible) {
  const debut = performance.now();
  const duree = () => Math.round(performance.now() - debut);
  const [min, max] = cible.expectStatus ?? [200, 399];
  try {
    const reponse = await fetch(cible.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(cible.timeoutMs ?? 12_000),
      headers: { 'user-agent': AGENT, accept: '*/*' },
    });
    // Le corps est lu puis jeté : sans cela la connexion reste ouverte et le process traîne.
    await reponse.arrayBuffer().catch(() => {});
    const ok = reponse.status >= min && reponse.status <= max;
    return {
      isUp: ok,
      httpStatus: reponse.status,
      responseTimeMs: duree(),
      error: ok ? null : `HTTP ${reponse.status} hors de la plage attendue ${min}-${max}`,
    };
  } catch (erreur) {
    const cause = erreur?.cause?.code ?? erreur?.name ?? '';
    const message = erreur?.message ?? String(erreur);
    return {
      isUp: false,
      httpStatus: null,
      responseTimeMs: duree(),
      error: `${cause}${cause ? ' — ' : ''}${message}`.slice(0, 200),
    };
  }
}

/**
 * Échéance du certificat. `rejectUnauthorized: false` est voulu : on inspecte le
 * certificat sans lui faire confiance, précisément pour pouvoir rapporter qu'il
 * est expiré. La validation réelle reste faite par la sonde HTTP ci-dessus.
 */
function certificat(url) {
  const adresse = new URL(url);
  if (adresse.protocol !== 'https:') return Promise.resolve(null);
  return new Promise((resoudre) => {
    let repondu = false;
    const fin = (valeur) => {
      if (repondu) return;
      repondu = true;
      try { prise.destroy(); } catch {}
      resoudre(valeur);
    };
    const prise = connect(
      {
        host: adresse.hostname,
        port: Number(adresse.port) || 443,
        servername: adresse.hostname,
        rejectUnauthorized: false,
        timeout: 8000,
      },
      () => {
        const cert = prise.getPeerCertificate();
        if (!cert?.valid_to) return fin(null);
        const echeance = new Date(cert.valid_to);
        if (Number.isNaN(echeance.getTime())) return fin(null);
        fin({
          validTo: echeance.toISOString(),
          daysLeft: Math.floor((echeance.getTime() - maintenant.getTime()) / MS_JOUR),
          issuer: cert.issuer?.O ?? null,
        });
      },
    );
    prise.on('error', () => fin(null));
    prise.on('timeout', () => fin(null));
  });
}

async function lireJson(chemin, defaut) {
  try {
    return JSON.parse(await readFile(chemin, 'utf8'));
  } catch {
    return defaut;
  }
}

const jourDe = (horodatage) => horodatage.slice(0, 10);

/** Disponibilité sur une fenêtre, en pourcentage ; `null` si aucune mesure. */
function disponibilite(points, jours) {
  const depuis = maintenant.getTime() - jours * MS_JOUR;
  const fenetre = points.filter((p) => Date.parse(p.timestamp) >= depuis);
  if (!fenetre.length) return null;
  return Math.round((fenetre.filter((p) => p.isUp).length / fenetre.length) * 1000) / 10;
}

function percentile(valeurs, rang) {
  if (!valeurs.length) return null;
  const triees = [...valeurs].sort((a, b) => a - b);
  return triees[Math.min(triees.length - 1, Math.floor((rang / 100) * triees.length))];
}

function latences(points) {
  const depuis = maintenant.getTime() - MS_JOUR;
  const mesures = points
    .filter((p) => p.isUp && Number.isFinite(p.responseTimeMs) && Date.parse(p.timestamp) >= depuis)
    .map((p) => p.responseTimeMs);
  if (!mesures.length) return { latest: null, avg: null, p95: null };
  return {
    latest: points.at(-1)?.responseTimeMs ?? null,
    avg: Math.round(mesures.reduce((somme, v) => somme + v, 0) / mesures.length),
    p95: percentile(mesures, 95),
  };
}

/** Un incident court du premier relevé en échec au premier relevé rétabli. */
function majIncidents(incidents, releve) {
  const ouvert = incidents.find((i) => !i.end);
  if (!releve.isUp && !ouvert) {
    incidents.unshift({ start: releve.timestamp, end: null, durationMs: null, error: releve.error });
  } else if (releve.isUp && ouvert) {
    ouvert.end = releve.timestamp;
    ouvert.durationMs = Date.parse(ouvert.end) - Date.parse(ouvert.start);
  }
  return incidents.slice(0, INCIDENTS_MAX);
}

function majAgregat(agregat, releve) {
  const date = jourDe(releve.timestamp);
  const jour = agregat.find((j) => j.date === date) ?? { date, checks: 0, up: 0 };
  jour.checks += 1;
  jour.up += releve.isUp ? 1 : 0;
  const autres = agregat.filter((j) => j.date !== date);
  return [...autres, jour].sort((a, b) => a.date.localeCompare(b.date)).slice(-JOURS_AGREGAT);
}

async function traiter(cible) {
  const chemin = join(HISTORIQUE, `${cible.id}.json`);
  const etat = await lireJson(chemin, { points: [], daily: [], incidents: [] });

  const [mesure, tls] = await Promise.all([sonder(cible), certificat(cible.url)]);
  const releve = { timestamp: maintenant.toISOString(), ...mesure };

  const limite = maintenant.getTime() - JOURS_BRUTS * MS_JOUR;
  etat.points = [...etat.points, releve].filter((p) => Date.parse(p.timestamp) >= limite);
  etat.daily = majAgregat(etat.daily ?? [], releve);
  etat.incidents = majIncidents(etat.incidents ?? [], releve);

  await writeFile(chemin, `${JSON.stringify(etat, null, 2)}\n`, 'utf8');

  return {
    id: cible.id,
    name: cible.name,
    url: cible.url,
    current: releve,
    availability: {
      last24h: disponibilite(etat.points, 1),
      last7d: disponibilite(etat.points, 7),
      last30d: disponibilite(etat.points, 30),
    },
    latencyMs: latences(etat.points),
    tls,
    daily: etat.daily.slice(-90),
    incidents: etat.incidents,
  };
}

async function principal() {
  const config = JSON.parse(await readFile(join(RACINE, 'targets.json'), 'utf8'));
  await mkdir(HISTORIQUE, { recursive: true });

  // En série : quatre cibles, et des relevés simultanés fausseraient les latences.
  const resultats = [];
  for (const cible of config.targets) resultats.push(await traiter(cible));

  await writeFile(
    join(DATA, 'status.json'),
    `${JSON.stringify(
      {
        generatedAt: maintenant.toISOString(),
        intervalMinutes: config.intervalMinutes ?? 5,
        targets: resultats,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const indisponibles = resultats.filter((r) => !r.current.isUp);
  for (const r of resultats) {
    const etat = r.current.isUp ? 'OK  ' : 'HORS';
    console.log(`${etat} ${r.name} — ${r.current.httpStatus ?? '—'} en ${r.current.responseTimeMs} ms`);
    if (r.current.error) console.log(`      ${r.current.error}`);
    if (r.tls && r.tls.daysLeft <= 15) console.log(`      certificat : ${r.tls.daysLeft} jours restants`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `down=${indisponibles.map((r) => r.name).join(', ')}\n`);
  }
}

await principal();
