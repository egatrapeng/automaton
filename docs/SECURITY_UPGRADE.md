# Mise à niveau : sécurité, autonomie et exploitation

Cette mise à niveau conserve l'administration du VPS, les outils de développement,
les installations npm, la réplication, les mises à jour et les achats autonomes.
Elle ne transforme pas un agent administrateur de son propre serveur en système
isolé de ce serveur. Aucun déploiement ni paiement réel n'a été effectué pendant
le développement et les tests.

## Modèle de menace et frontières

Actifs : clés de portefeuille et API, données métier, historique, budget et accès
au VPS. Entrées non fiables : messages sociaux, cartes d'agents, pages web,
réponses d'outils, exigences de paiement et nouveaux paquets/code amont.

Le modèle et les contenus externes peuvent proposer des actions ; les contrôles
de montant, protocole, provenance et comptabilité sont exécutés dans le code.
Les fournisseurs d'inférence, le relais, Conway et les registres de paquets restent
des tiers. TLS protège le transport, pas l'innocuité de leurs réponses.

Deux cibles d'exécution sont disponibles :

- `execution.mode: "host"` : administration du VPS avec les droits du compte du
  runtime. Ce mode est volontairement puissant. Les processus n'héritent que d'un
  environnement limité, leurs sorties et délais sont bornés et le shell ne bloque
  plus la boucle Node. Cela ne limite ni la mémoire globale, ni les démons qu'un
  administrateur décide de lancer, ni ses accès OS aux fichiers/réseaux.
- `execution.mode: "remote"` avec un `sandboxId` valide : les opérations du client
  Conway visent cette sandbox. Une erreur distante ne provoque pas un repli local.
  La sécurité effective de la sandbox dépend de son fournisseur. Les espaces de
  travail locaux de l'orchestrateur restent locaux ; ce mode ne constitue pas une
  certification de séparation de tous les processus du runtime.

Les racines de fichiers et filtres protègent les API de lecture/écriture ; ils ne
restreignent pas le shell d'administration. Sous Linux, les accès locaux vérifient
la cible réelle et le descripteur ouvert avant lecture ou troncature. Les garanties
ne couvrent pas tous les alias de même inode (liens physiques), les montages hostiles
ou tous les entrelacements possibles de création des répertoires. L'API distante
ne fournit pas les mêmes contrôles de descripteur : ne pas lui attribuer les garanties
de l'implémentation locale.

## Décisions pour préserver les fonctions de l'agent

| Mesure envisagée | Décision et raison | Risque restant |
| --- | --- | --- |
| Interdire tout shell ou root | Non imposé : empêcherait l'administration souhaitée. Mode hôte explicite conservé. | Un agent administrateur peut lire/modifier ses propres secrets et protections. |
| Remplacer tout par un conteneur obligatoire | Non imposé : il ne pourrait plus administrer librement l'hôte et pourrait nécessiter une machine plus grande. | Aucune isolation OS complète n'est revendiquée pour le profil hôte. |
| Signataire inaccessible à l'administrateur du même VPS | Non présenté comme une garantie : root peut inspecter ou remplacer un service local. | Pour obtenir cette frontière, il faut un signataire séparé avec ses propres règles, hors de l'autorité de l'agent. Non implémenté ici. |
| Bloquer tous les messages sans nouvelle preuve cryptographique | Non imposé : casserait le protocole historique et les boîtes de réception différées. | Les messages historiques restent lisibles avec autorité externe, sans identité locale garantie. |
| Validation humaine de chaque achat/mise à jour | Non imposée : casserait l'autonomie. Limites persistantes et revue de révision exacte appliquées. | La revue du modèle n'est pas une approbation humaine et n'assure pas l'innocuité du code. |
| Interdire tous les scripts npm | Non imposé par défaut : certains outils natifs en ont besoin. Version/empreinte de l'archive vérifiées avant installation. | Ces scripts exécutent du code tiers ; les dépendances transitives de nouveaux outils ne sont pas toutes gelées. |
| Supprimer automatiquement l'historique | Non imposé : détruirait mémoire, audit et possibilités de récupération. | Les données antérieures ne sont pas nettoyées rétroactivement ; rétention à décider avec l'opérateur. |
| Couper tous les réseaux privés | Non imposé sur les backends configurés : Ollama et des API internes doivent rester utilisables. | Un backend configuré est de confiance. Le shell hôte n'est pas filtré par les helpers HTTP. |

Ces choix correspondent à la consigne de préserver les fonctions nécessaires.
Ils ne signifient pas que les risques cités sont supprimés. Ne pas placer de données
personnelles ni un portefeuille principal sur un hôte administré par l'agent.

## Corrections effectives

- Plus de sélection locale implicite faute de sandbox. Les nouvelles configurations
  enregistrent une cible explicite ; les anciennes doivent être migrées.
- Filtrage de l'environnement des outils, exécution asynchrone, délai maximum et
  volume de sortie bornés. Aucun accès de l'agent à des secrets par variables
  héritées n'est ajouté par défaut. Les fichiers restent soumis aux droits OS.
- Contrôles de cibles réelles pour les fichiers locaux, sans transformer un refus
  en lecture shell. Les replis des harnesses ne passent plus de distant à hôte.
- Recharge plafonnée au montant choisi, USDC/réseau/bénéficiaire/durée validés,
  calcul entier, absence de retry/redirection d'une requête signée.
- Réservations SQLite atomiques avant signature, cumul heure/jour/destination et
  états d'autorisation persistants. Les outils remontent les montants réels.
- Provenance externe conservée dans les messages, les suites de tours et les
  délégations. Vérification des signatures fournies et déduplication persistante.
- Masquage des secrets enregistrés et formats reconnus dans logs, requêtes
  d'inférence et nouveaux tours/appels persistés. L'authentification et l'exécution
  reçoivent leurs valeurs nécessaires. Ce n'est pas un outil DLP exhaustif.
- URLs publiques contrôlées (IPv4/IPv6/DNS), redirections encadrées et réponses
  bornées. La validation DNS préalable ne verrouille pas l'adresse de connexion :
  le DNS rebinding doit aussi être traité au proxy/pare-feu.
- Réplication du fork choisi à un SHA précis ; refus avant provisionnement si les
  modifications suivies n'ont pas été commitées. Pas de push/reset automatique.
  Mises à jour liées au diff et récupération avec sauvegardes.
- Tokenisation synchrone bornée et cache limité ; estimation conservatrice pour
  les longues entrées, sans suppression silencieuse des données métier.

## Migration et configuration

Sauvegarder les fichiers de configuration et bases dans un emplacement privé avant
mise à niveau. Ne pas modifier ni partager les clés. Installer depuis une révision
revue, avec Node 22 et pnpm 10.28.1, puis lancer :

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
node dist/index.js --help
pnpm test --maxWorkers=2 --minWorkers=1
```

Pour un ancien `~/.automaton/automaton.json`, utiliser `--configure`, section General,
ou éditer le JSON pour choisir explicitement la cible. Ne pas remplacer l'ensemble
du fichier par les fragments ci-dessous : conserver tous les champs existants.

Extrait pour le VPS administré directement :

```json
{
  "sandboxId": "",
  "execution": {
    "mode": "host",
    "workingDirectory": "/home/automaton",
    "maxTimeoutMs": 300000,
    "maxOutputBytes": 1048576,
    "environmentAllowlist": []
  }
}
```

Adapter le répertoire au compte réel (`/root` si l'opérateur choisit root).
`readRoots` et `writeRoots` sont optionnels et limitent les API de fichiers, pas
le shell. Ajouter une variable à `environmentAllowlist` la rend lisible par les
outils : ne pas y mettre les clés du portefeuille ou du fournisseur d'IA.

Pour Conway, utiliser `execution: {"mode":"remote"}` avec le véritable sandboxId.
Ne pas conserver simultanément un sandboxId et le mode host.

Les nouveaux champs de trésorerie optionnels sont des cents entiers :

```json
{
  "maxX402HourlyCents": 1000,
  "maxX402DailyCents": 2000,
  "maxX402DestinationDailyCents": 1000,
  "minimumUsdcReserveCents": 0
}
```

Ce fragment va dans `treasuryPolicy` et ne remplace pas ses autres champs. Sans
valeurs explicites, les plafonds cumulés x402 sont 100 USD/heure et 250 USD/jour.
Pour un petit budget, les diminuer avant le lancement. `maxX402PaymentCents` reste
le plafond de l'outil x402 général ; une recharge utilise le montant de son palier
sélectionné, dans les plafonds cumulés. La réserve USDC est distincte de la réserve
de crédits Conway : confondre les deux bloquerait le bootstrap de 5 USD.
`x402AllowedRecipients` peut épingler des bénéficiaires EVM connus ; son absence
préserve les bénéficiaires dynamiques du protocole. `x402AllowedDomains` s'applique
à l'outil web payant ; l'endpoint de recharge est celui configuré par l'opérateur.

Ne pas supprimer `payment-ledger.db` pour contourner un budget. Protéger et
sauvegarder cette base avec l'état. `accepted` signifie acceptation HTTP, pas
confirmation on-chain. Un résultat incertain conserve sa réservation ; utiliser
le même `operation_id` pour une même intention d'achat et réconcilier son résultat
avant une nouvelle demande. La réconciliation on-chain automatique n'est pas
implémentée. Plusieurs achats distincts restent autorisés dans les plafonds.

## Exploitation et retour arrière

Préparation reproductible sur Ubuntu 24.04 (commandes administrateur, à adapter
au répertoire et au commit effectivement revu et publié ; ne pas coller un
placeholder de commit comme s'il s'agissait d'une version disponible) :

```sh
apt-get update
apt-get install -y git ca-certificates nodejs npm build-essential python3
npm install --prefix /opt/automaton-tools --no-audit --no-fund node@22.23.4 pnpm@10.28.1
export PATH=/opt/automaton-tools/node_modules/.bin:$PATH
git clone https://github.com/egatrapeng/automaton.git /opt/automaton
cd /opt/automaton
# Choisir et vérifier le commit contenant les correctifs revus avant installation.
git checkout --detach COMMIT_COMPLET_REVU_ET_PUBLIE
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test --maxWorkers=2 --minWorkers=1
```

Pour le compte dédié, le créer puis lui attribuer les répertoires de travail et
le checkout qu'il doit modifier, pas tous les fichiers du VPS. Lancer l'assistant
`node /opt/automaton/dist/index.js --run` sous le même compte/HOME que le futur
service ; terminer le choix des fournisseurs, du mode et des budgets avant de
passer en fonctionnement continu. Les identifiants sont entrés dans l'assistant
ou les paramètres prévus, jamais dans la ligne de commande ni le fichier service.

Un [exemple systemd](../scripts/automaton.service.example) est fourni, sans être
installé ou activé automatiquement. En compte root, adapter également HOME et la
configuration existante : ce choix donne le contrôle de tout le VPS à l'agent.
Les limites MemoryMax/TasksMax protègent la capacité disponible, pas les secrets.

Un compte dédié limite l'impact sur le reste du VPS. Si l'opérateur souhaite root,
le profil host le permet explicitement ; les garanties de séparation ne suivent
pas. Garder la clé SSH privée de l'opérateur hors du VPS. Les processus lancés
volontairement comme démons relèvent de l'administration et ne sont pas tous
récupérables par le délai d'un seul appel shell.

Utiliser un gestionnaire de services avec répertoire de travail, HOME et PATH des
outils explicites, redémarrage après échec et limites de ressources adaptées. Sur
un VPS 4 Gio, commencer avec deux workers, surveiller RSS/disque et les coûts API.
Ne pas déduire de nos mesures synthétiques une capacité d'inférence locale.

Avant de répliquer cette mise à niveau, commiter la révision revue et vérifier
qu'elle est récupérable depuis l'origine choisie. Les modifications non commitées
ne peuvent pas être reproduites par un clone distant ; le provisionnement est
refusé explicitement plutôt que de déployer silencieusement une ancienne version.

Les mises à jour créent une référence Git de retour arrière. La récupération
destructive exige un aperçu puis un hash exact et archive le checkout avant reset.
Ces sauvegardes peuvent contenir des secrets et être volumineuses. Les conserver
privées. Pour revenir en arrière, arrêter l'agent, sauvegarder son état courant,
examiner la référence/archive, restaurer dans un répertoire distinct, réinstaller
avec lockfile puis valider avant relancement. Ne pas restaurer une ancienne base
de paiements qui effacerait des autorisations déjà émises.

## Validation et limites

Les tests couvrent faux secrets, faux signataires, budget concurrent/persistant,
provenance et signatures, refus distants, fichiers/liens, redirections et reprise
des opérations normales. Un parcours simulé exécute une vraie commande dans un
répertoire temporaire, persiste son résultat masqué et arrête la boucle proprement.
Un autre vérifie l'autorisation de 5 USD, le reporting et le refus de doublon.

Les clés réelles, paiements on-chain, services Conway et provisionnements réels
ne sont pas utilisés par ces tests. Aucun benchmark complet sur le VPS cible n'a
été réalisé. Le signataire distant, la protection réseau au point de connexion,
la réconciliation on-chain et une immutabilité OS des protections ne sont pas
implémentés. La version ne doit donc pas être décrite comme entièrement sécurisée.

Les limites atomiques ajoutées couvrent les autorisations x402, y compris les
recharges automatiques. Elles ne rendent pas atomique tout appel indépendant de
transfert de crédits Conway ni toute dépense effectuée directement par un shell.
Les plafonds existants de transfert restent applicatifs. Leur coordination avec
un contrôle de compte côté fournisseur est nécessaire pour une garantie globale.

Voir aussi [performance](context-performance.md), [confidentialité](privacy-boundaries.md),
[réseau](network-security.md), [messages](social-trust.md) et [sources](SUPPLY_CHAIN.md).
