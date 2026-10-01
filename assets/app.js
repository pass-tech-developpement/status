/*
 * Rendu de la page de statut à partir de data/status.json.
 *
 * Règle directrice : une page de supervision figée affiche du vert et rassure à
 * tort. Le contrôle de fraîcheur passe donc avant tout le reste, et barre les
 * indicateurs dès que les relevés se sont interrompus.
 */
const JOURS_BANDE = 90;
/** Au-delà de trois cycles manqués (15 min au minimum), les relevés sont déclarés interrompus. */
const CYCLES_TOLERES = 3;
const FRAICHEUR_MIN_MINUTES = 15;

const nombre = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const dateCourte = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
const dateHeure = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

const ETATS = {
  good: 'Opérationnel',
  warning: 'Dégradé',
  serious: 'Perturbé',
  critical: 'Indisponible',
  none: 'Sans mesure',
};

/** État d'une journée d'après la part de mesures réussies. */
function etatDuJour(jour) {
  if (!jour || !jour.checks) return 'none';
  const part = jour.up / jour.checks;
  if (part === 1) return 'good';
  if (part >= 0.95) return 'warning';
  if (part >= 0.5) return 'serious';
  return 'critical';
}

function duree(ms) {
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  return `${heures} h ${String(minutes % 60).padStart(2, '0')}`;
}

const pourcent = (valeur) => (valeur === null || valeur === undefined ? '—' : `${nombre.format(valeur)} %`);
const millisecondes = (valeur) => (Number.isFinite(valeur) ? `${nombre.format(valeur)} ms` : '—');

/** Jours manquants comblés : une sonde arrêtée doit laisser un trou visible, pas disparaître. */
function bandeComplete(daily) {
  const connus = new Map((daily ?? []).map((j) => [j.date, j]));
  const jours = [];
  for (let i = JOURS_BANDE - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    jours.push(connus.get(date) ?? { date, checks: 0, up: 0 });
  }
  return jours;
}

function element(balise, classe, texte) {
  const noeud = document.createElement(balise);
  if (classe) noeud.className = classe;
  if (texte !== undefined) noeud.textContent = texte;
  return noeud;
}

function chiffre(libelle, valeur) {
  const bloc = document.createElement('div');
  bloc.append(element('dt', null, libelle), element('dd', null, valeur));
  return bloc;
}

function rendreBande(service) {
  const jours = bandeComplete(service.daily);
  const bande = element('div', 'bande');
  bande.setAttribute('role', 'img');
  const indisponibles = jours.filter((j) => j.checks && j.up < j.checks).length;
  const sansMesure = jours.filter((j) => !j.checks).length;
  bande.setAttribute(
    'aria-label',
    `Disponibilité quotidienne sur ${JOURS_BANDE} jours : ${jours.length - indisponibles - sansMesure} jours sans incident, ` +
      `${indisponibles} jours avec incident, ${sansMesure} jours sans mesure. Détail dans le tableau ci-dessous.`,
  );

  for (const jour of jours) {
    const etat = etatDuJour(jour);
    const cellule = element('div', 'jour');
    cellule.dataset.etat = etat;
    const part = jour.checks ? ` — ${pourcent(Math.round((jour.up / jour.checks) * 1000) / 10)} sur ${jour.checks} mesures` : '';
    cellule.dataset.infobulle = `${dateCourte.format(new Date(jour.date))} — ${ETATS[etat]}${part}`;
    bande.append(cellule);
  }

  const reperes = element('div', 'bande-reperes');
  reperes.append(element('span', null, `il y a ${JOURS_BANDE} jours`), element('span', null, "aujourd'hui"));

  const enveloppe = document.createDocumentFragment();
  enveloppe.append(bande, reperes);
  return enveloppe;
}

/** Tableau : le chemin accessible vers le détail, et la preuve que la couleur n'est pas seule. */
function rendreTableau(service) {
  const bloc = document.createElement('details');
  bloc.append(element('summary', null, 'Détail des 30 derniers jours et incidents'));

  const table = document.createElement('table');
  const entete = document.createElement('tr');
  for (const titre of ['Jour', 'État', 'Mesures', 'Réussies', 'Disponibilité']) {
    entete.append(element('th', null, titre));
  }
  table.append(entete);

  for (const jour of bandeComplete(service.daily).slice(-30).reverse()) {
    const ligne = document.createElement('tr');
    const dispo = jour.checks ? Math.round((jour.up / jour.checks) * 1000) / 10 : null;
    ligne.append(
      element('td', null, dateCourte.format(new Date(jour.date))),
      element('td', null, ETATS[etatDuJour(jour)]),
      element('td', null, String(jour.checks)),
      element('td', null, String(jour.up)),
      element('td', null, pourcent(dispo)),
    );
    table.append(ligne);
  }
  bloc.append(table);

  if (service.incidents?.length) {
    bloc.append(element('p', 'note', 'Incidents récents'));
    const liste = document.createElement('table');
    const te = document.createElement('tr');
    for (const titre of ['Début', 'Fin', 'Durée', 'Cause relevée']) te.append(element('th', null, titre));
    liste.append(te);
    for (const incident of service.incidents) {
      const ligne = document.createElement('tr');
      ligne.append(
        element('td', null, dateHeure.format(new Date(incident.start))),
        element('td', null, incident.end ? dateHeure.format(new Date(incident.end)) : 'en cours'),
        element('td', null, incident.end ? duree(incident.durationMs) : '—'),
        element('td', null, incident.error ?? '—'),
      );
      liste.append(ligne);
    }
    bloc.append(liste);
  }
  return bloc;
}

function rendreService(service) {
  const carte = element('article', 'service');

  const entete = element('header', 'service-entete');
  const etat = service.current.isUp ? 'good' : 'critical';
  const pastille = element('span', 'pastille');
  pastille.dataset.etat = etat;
  pastille.setAttribute('aria-hidden', 'true');

  const titre = element('h2', null, service.name);
  const lien = element('a', 'cible', service.url);
  lien.href = service.url;
  lien.rel = 'noopener';

  entete.append(pastille, titre, lien, element('p', 'etat', ETATS[etat]));
  carte.append(entete);

  const chiffres = element('dl', 'chiffres');
  chiffres.append(
    chiffre('24 heures', pourcent(service.availability.last24h)),
    chiffre('7 jours', pourcent(service.availability.last7d)),
    chiffre('30 jours', pourcent(service.availability.last30d)),
    chiffre('Latence p95', millisecondes(service.latencyMs.p95)),
  );
  if (service.tls) {
    const jours = service.tls.daysLeft;
    chiffres.append(chiffre('Certificat', jours < 0 ? 'expiré' : `${jours} j`));
  }
  carte.append(chiffres, rendreBande(service), rendreTableau(service));

  if (!service.current.isUp && service.current.error) {
    carte.append(element('p', 'note', `Dernière erreur : ${service.current.error}`));
  }
  return carte;
}

function rendreFraicheur(donnees) {
  const bandeau = document.getElementById('fraicheur');
  const ageMinutes = (Date.now() - Date.parse(donnees.generatedAt)) / 60000;
  const tolerance = Math.max(FRAICHEUR_MIN_MINUTES, (donnees.intervalMinutes ?? 5) * CYCLES_TOLERES);
  if (ageMinutes <= tolerance) return;

  document.body.classList.add('perime');
  bandeau.hidden = false;
  const texte = element('div');
  texte.append(
    element('strong', null, `Relevés interrompus depuis ${duree(ageMinutes * 60000)}`),
    element(
      'span',
      null,
      `Dernière mesure le ${dateHeure.format(new Date(donnees.generatedAt))}. ` +
        'Les indicateurs ci-dessous décrivent le passé, pas l’état actuel des services : la sonde elle-même est en panne.',
    ),
  );
  bandeau.append(element('span', 'pastille', ''), texte);
  bandeau.firstChild.dataset.etat = 'critical';
}

function brancherInfobulle() {
  const bulle = document.getElementById('infobulle');
  document.addEventListener('mouseover', (evenement) => {
    const cible = evenement.target.closest('[data-infobulle]');
    if (!cible) return;
    bulle.textContent = cible.dataset.infobulle;
    bulle.hidden = false;
    const boite = cible.getBoundingClientRect();
    bulle.style.left = `${Math.min(window.innerWidth - bulle.offsetWidth - 8, Math.max(8, boite.left - bulle.offsetWidth / 2))}px`;
    bulle.style.top = `${Math.max(8, boite.top - bulle.offsetHeight - 8)}px`;
  });
  document.addEventListener('mouseout', (evenement) => {
    if (evenement.target.closest('[data-infobulle]')) bulle.hidden = true;
  });
}

async function principal() {
  const conteneur = document.getElementById('services');
  try {
    const reponse = await fetch(`data/status.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`);
    const donnees = await reponse.json();

    rendreFraicheur(donnees);
    conteneur.textContent = '';
    for (const service of donnees.targets) conteneur.append(rendreService(service));
    conteneur.setAttribute('aria-busy', 'false');

    document.getElementById('horodatage').textContent =
      `Dernier relevé le ${dateHeure.format(new Date(donnees.generatedAt))}, sonde toutes les ${donnees.intervalMinutes} minutes.`;
    brancherInfobulle();
  } catch (erreur) {
    conteneur.textContent = '';
    conteneur.append(
      element('p', 'note', `Relevés illisibles (${erreur.message}). La sonde n’a peut-être jamais tourné.`),
    );
    conteneur.setAttribute('aria-busy', 'false');
  }
}

principal();
