# État des services Pass Tech

Sonde de disponibilité et page de statut publique, exécutées par GitHub Actions
et publiées par GitHub Pages.

👉 **https://pass-tech-developpement.github.io/status/**

## Pourquoi ici, et pas sur nos serveurs

La supervision applicative (`services.tech.fr`) tourne sur l'un des serveurs
qu'elle surveille. Elle ne peut donc pas signaler sa propre panne, ni celle du
serveur qui l'héberge : le jour où celui-ci s'arrête, la page de statut s'arrête
avec lui, au moment précis où les utilisateurs la cherchent.

Ce dépôt corrige cet angle mort. Les sondes partent de l'infrastructure GitHub,
extérieure à l'hébergeur, et la page est servie par GitHub Pages : elle reste
consultable même si les deux serveurs sont arrêtés simultanément.

Les deux dispositifs sont **complémentaires et se surveillent mutuellement** :

| | Ce dépôt | `services.tech.fr` |
|---|---|---|
| Point de vue | extérieur | intérieur |
| Voit | la disponibilité publique, la latence, l'échéance des certificats | l'état interne : files d'attente, tâches planifiées, volumes, sauvegardes |
| Sait faire | survivre à la panne des serveurs | signer les documents de contrôle de maintenance, gérer les abonnements |
| Surveille | `services.tech.fr` | la fraîcheur de cette page (voir plus bas) |

## Le piège de la page figée

**Une page de supervision arrêtée n'affiche pas une erreur : elle affiche du
vert.** C'est le mode de défaillance le plus courant de ce type d'outil, et le
plus trompeur.

Deux protections sont donc intégrées :

- la page vérifie l'âge du dernier relevé. Au-delà de trois cycles manqués, un
  bandeau rouge annonce l'interruption et les pourcentages de disponibilité sont
  barrés — ils décrivent le passé, pas l'état courant ;
- `data/status.json` expose `generatedAt`. **`services.tech.fr` doit vérifier que
  cette date a moins de quinze minutes et alerter sinon.** Sans ce contrôle
  réciproque, ce dépôt ajoute simplement un second endroit où une panne passe
  inaperçue.

Les workflows planifiés de GitHub sont par ailleurs désactivés après 60 jours
sans activité sur le dépôt. Chaque passage écrivant un relevé, l'activité ne
s'interrompt jamais tant que la sonde fonctionne.

## Pourquoi un dépôt public

Le plan Free de l'organisation accorde 2 000 minutes d'Actions par mois pour
l'ensemble des dépôts privés, et GitHub Pages n'y est pas disponible. Une sonde
toutes les cinq minutes représente environ 8 640 exécutions mensuelles : plus de
quatre fois ce quota, pour un seul workflow.

Sur un dépôt public, les minutes sont illimitées et Pages est gratuit. Ce dépôt
n'expose que les URL surveillées — toutes publiques — et leur historique de
disponibilité : c'est précisément ce qu'une page de statut est faite pour
montrer. **N'y placez jamais d'URL interne, de jeton ni d'identifiant.**

## Ajouter ou modifier un service

Tout se joue dans [`targets.json`](targets.json) :

```json
{
  "id": "mon-service",
  "name": "Nom affiché",
  "url": "https://exemple.tech.fr/healthz",
  "expectStatus": [200, 299],
  "timeoutMs": 12000
}
```

- `expectStatus` est une plage inclusive. `[200, 399]` convient à une page
  d'accueil qui redirige vers une connexion ; `[200, 299]` à une sonde de santé.
- Préférez un point d'entrée de santé à la page d'accueil quand il en existe un :
  `mej-crm.tech.fr/healthz` dit que Twenty répond vraiment, là où la page
  d'accueil peut s'afficher avec une base de données en panne.

Un push sur `main` touchant ce fichier déclenche un relevé immédiat.

## Fonctionnement

```
.github/workflows/uptime.yml   planification (*/5), publication du relevé
scripts/check.mjs              sonde HTTP + lecture du certificat, agrégation
targets.json                   services surveillés
data/status.json               dernier état, lu par la page
data/history/<id>.json         points bruts (30 j), agrégat quotidien (400 j), incidents
index.html assets/             page de statut
```

Chaque passage écrit un point par service, met à jour l'agrégat quotidien et
ferme ou ouvre les incidents. Les points bruts sont bornés à 30 jours pour que le
dépôt ne gonfle pas ; l'agrégat quotidien conserve l'historique long.

Quand un service est indisponible, le relevé est **d'abord enregistré**, puis le
workflow échoue : la notification GitHub part vers les personnes qui suivent le
dépôt, sans que la donnée soit perdue.

## Exécuter en local

```sh
node scripts/check.mjs          # écrit data/
python3 -m http.server 8000     # puis ouvrir http://localhost:8000
```

Derrière un proxy d'entreprise qui intercepte TLS, toutes les sondes échouent en
`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` et le certificat lu est celui du proxy : ne
pas commettre les relevés produits dans ces conditions.
