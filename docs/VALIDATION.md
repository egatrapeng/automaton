# Validation de la mise à niveau

## Complément du 4 novembre 2026 : Wallet Guardian

- Construction TypeScript du runtime et de la CLI : réussie ; typecheck réussi.
- Suite complète : **75 fichiers, 1 863 tests réussis**, aucun échec ou skip,
  22,15 secondes. Commande :
  `NODE_USE_ENV_PROXY=1 pnpm test --maxWorkers=2 --minWorkers=1`.
- 65 tests dédiés au signataire : autorité du propriétaire, QQOQCCP, historique
  des plans, budget concurrent/persistant, coût cumulatif, valorisation EUR,
  retrait exact, panne après signature, refus des en-têtes de routage,
  confidentialité et copie durable du journal local, absence de repli local.
- Initialisation CLI testée dans un répertoire temporaire : portefeuille neuf
  vide, fichiers 0600, politique EUR et source de prix explicites, aucune clé
  affichée et refus d'écraser un portefeuille existant.
- Assistant Python testé avec configuration et jetons factices : prompt et
  clé Claude conservés, plafond zéro conservé, sauvegarde et jeton privés.
- Aides des CLI et `git diff --check` : réussis.

Les services de paiement, RPC et prix de ces tests sont simulés. Aucun fonds
déplacé, aucun service installé sur le VPS, aucune requête réelle à CoinGecko et
aucun règlement réel revendiqué. Le prix public, le proxy HTTPS, le filtrage
réseau et l'hôte indépendant restent à vérifier lors du déploiement. Un agent
root du même hôte peut toujours contourner une protection locale ; le mode
indépendant exige une nouvelle clé hors de son autorité.

Voir le [guide d'installation et les limites](WALLET_GUARDIAN.md).

## Validation initiale

3 novembre 2026, Node 22.23.4, pnpm 10.28.1. Aucun secret réel, achat ou
provisionnement réel utilisé. Les dépendances et lockfiles n'ont pas été changés.

## Vérifications exécutées

| Vérification | Résultat |
| --- | --- |
| `pnpm run typecheck` | Réussi |
| `pnpm run build` (runtime et CLI) | Réussi |
| `NODE_USE_ENV_PROXY=1 pnpm test --maxWorkers=2 --minWorkers=1` | 73 fichiers, 1 793 tests réussis, aucun échec/skip ; 20,06 s |
| `node dist/index.js --help` | Réussi |
| `node packages/cli/dist/index.js --help` | Réussi |
| `sh -n scripts/automaton.sh` | Réussi |
| `git diff --check` | Réussi |

Les appels réseau des tests de boucle, de routage d'outil et d'énumération qui
attendaient des services externes ont été remplacés par des fixtures ciblées.
Les tests réseau dédiés vérifient toujours les refus/redirections/DNS avec des
réponses et résolutions contrôlées. Les tests de faux portefeuille et de faux
signataire n'utilisent pas de fonds ni de clés de production.

Les tests locaux de sous-processus nécessitent l'accès aux fonctions système ;
le sandbox de commandes de cette session peut renvoyer EPERM pour un Node
imbriqué. Ils ont été exécutés avec l'autorisation correspondante, sans supprimer
les vérifications, sans désactiver TLS et sans transformer les délais en succès.

## Mesures de performance

`node --import tsx scripts/benchmark-context.ts` a été exécuté. Le contexte réel
de mesure était une limite CPU de 4 cœurs et 32 Gio de mémoire ; il ne s'agit pas
du VPS cible de 2 vCPU/4 Gio.

- Ancien encodage brut d'une chaîne répétitive de 50 000 caractères : interruption
  après 2,5 s, explicitement comptabilisée comme délai dépassé.
- Nouveau compteur sur cette entrée : p50 0,011 ms, p95 0,034 ms.
- Nouvelle entrée de 500 000 caractères : p50 0,204 ms, p95 0,538 ms.
- Initialisation du compteur : environ 350 ms ; RSS du benchmark environ 205 Mio,
  chargeur TypeScript compris. Ce n'est pas le RSS du runtime en service.

Ces mesures concernent l'estimation conservatrice du budget de contexte, pas une
accélération équivalente de l'inférence, ni un débit garanti d'Automaton. Voir
[le détail de la méthode](context-performance.md).

## Non validé ou volontairement non imposé

- Aucun déploiement du service systemd, de l'agent sur un VPS ou d'un enfant Conway.
- Pas de paiement on-chain ni de test de règlement réel des signatures.
- Pas de signataire matériel ; le mode distant et la réconciliation Wallet
  Guardian sont vérifiés sur mocks, sans transaction ou connexion de production.
- Pas de benchmark complet mémoire/CPU/disque de l'agent en production.
- Pas d'audit exhaustif actuel des dépendances transitives ou de leur absence de
  code malveillant ; empreintes et versions ne prouvent pas l'innocuité.
- Pas d'isolation contre un agent disposant des droits administrateur du même
  hôte. Pas de garantie réseau au point de connexion sans proxy/pare-feu adapté.
- Pas de nettoyage rétroactif automatique des secrets de l'historique ancien.

Les choix permettant de garder l'agent opérationnel et les garanties restantes
sont détaillés dans [le guide de migration et d'exploitation](SECURITY_UPGRADE.md).
Se référer à l'historique Git pour les versions publiées. La disponibilité d'un
commit sur le fork ne signifie pas que cette version est installée sur le VPS.

## Trading V1 — 4 novembre 2026

| Vérification | Résultat |
| --- | --- |
| Typage et compilation runtime/CLI | Réussis |
| Suite complète Vitest | **78 fichiers, 1 939 tests réussis**, aucun échec ; dernier passage complet 24,48 s |
| SDK AgentKit publié 0.10.4 | 3 tests Node réussis avec faux HTTP, plus self-test des 5 actions ; signatures/transferts refusés |
| Image guardian | Construite avec le Node épinglé et le certificat proxy ; SDK facultatif exclu de cette image |
| Test de l'image sans réseau | Serveur compilé, SQLite, configuration de mode, observer GET et refus POST vérifiés dans un volume jetable non financé |
| Scripts de déploiement | Syntaxe Bash validée ; conservation Compose/configuration et exclusion des données privées testées |
| Empreintes | Skills locaux et intégrité du paquet AgentKit conformes au manifeste de provenance |

Les scénarios de trading utilisent uniquement des RPC, marchés, reçus et
signatures simulés : swaps dans les deux sens, gas/nonce/liquidité, autorisation
exacte, verrou commun avec services et retraits, timeout/redémarrage sans
rediffusion, frais de reverts, refus de données périmées et dépôts exclus du PnL.
Le diagnostic public sur Hostinger et le déploiement sur les deux VPS restent à
effectuer avec les [commandes de déploiement](TRADING_V1.fr.md). Aucun ordre de
production ou rendement réel n'est attesté par ces tests. Le raccordement du
dashboard existant est décrit pour son backend extérieur à ce dépôt.

Correctif du coût d'inférence dans le rapport trading : lecture de
`inference_costs` avec la même fonction et les mêmes bornes UTC que le contrôle
budgétaire du routeur, au lieu de `spend_tracking`. Les 118 tests ciblés
(routeur, moteur trading et rapport) passent, ainsi que le typage et la
compilation. Quatre nouveaux tests couvrent les 293 centimes absents de l'autre
table, le changement de jour UTC, une source indisponible et un jour sans coût.
Ce correctif d'affichage ne modifie ni plafond ni décision de trading.
