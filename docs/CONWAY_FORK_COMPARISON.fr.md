# Comparaison des forks et autonomie économique sans Conway

Étude du 4 novembre 2026. Point de départ :
[Conway-Research/automaton](https://github.com/Conway-Research/automaton).
Conclusion : garder notre version et y intégrer des améliorations ciblées.
L'absence de Conway ne bloque ni le développement local, ni la publication d'un
service, ni la réception de paiements. Elle retire ses services propriétaires de
provisionnement, de crédits, de domaines et de colonie distante.

## Méthode et portée

- Consultation de trois pages de forks GitHub : première page populaire,
  deuxième page populaire et première page récemment mise à jour.
- Lecture des README de **56 dépôts distincts** ; inventaire et empreintes dans
  [l'inventaire CSV](research/automaton-forks-2026-11-04.csv).
- Inspection approfondie du code de deux candidats pertinents, sans exécuter
  leur code, installer leurs dépendances ou leur confier de clés.
- Comparaison avec notre branche de départ
  `security/wallet-guardian-operational-spend`, commit
  `29fc8611cabde5cd4ae89b79a611481f1b3c7d54`.

Cette recherche n'est pas un examen exhaustif de tous les forks. Un README
inchangé ne prouve pas l'absence de modifications utiles. Les tests et la
rentabilité revendiqués par un tiers n'ont pas été validés par cette étude.

## Candidats

| Version | Ce qui est effectivement présent | Conclusion |
| --- | --- | --- |
| [Piloxita/automaton](https://github.com/Piloxita/automaton/tree/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47) | `hostingMode: selfhosted`, démarrage sans clé Conway, relais d'inférence, consignes métier, superviseur de services et tunnels Cloudflare | Candidat le plus pertinent parmi ceux examinés pour un fonctionnement indépendant. Reprendre des principes, pas remplacer notre installation. |
| [agentic-reserve/automaton](https://github.com/agentic-reserve/automaton/tree/9ccdf7240e0602098b6fe7cf12da330ed19d0951) | Documentation et modules OpenRouter, extensions expérimentales | Son `src/index.ts` exige encore une clé Conway au démarrage. Un autre fournisseur de modèles ne rend pas tout le runtime indépendant. |
| Notre version | Claude direct, administration du VPS, budgets, signataire distant, journal et déploiement utilisateur existant | Conserver cette base. Le suivi de plans en standalone et la mission économique étaient les lacunes les plus immédiates. |

### Piloxita : références de code et limites

Sources inspectées au commit indiqué :

- [README](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/README.md) : annonce explicitement « no Conway at all ».
- [Identité et méthode de travail](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/src/agent/system-prompt.ts) : sélectionner un client, prouver un besoin, expliquer l'avantage face à un LLM seul et fixer un critère d'abandon avant de construire.
- [Superviseur](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/deploy/container/services-runner.mjs) : processus déclarés, redémarrage avec temporisation, statut et tunnels pour les services publics.
- [Relais Claude](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/deploy/relay/claude-relay.py) : socket Unix, CLI avec outils désactivés et nombre d'appels plafonné. Ce n'est pas la même intégration que notre API Anthropic directe ; ne pas changer de méthode d'authentification ou de facturation implicitement.
- [Adaptateur d'inférence](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/src/inference/selfhosted-unified-client.ts) : route les appels auxiliaires vers le client configuré mais renvoie des champs de coût à zéro. Avant toute reprise, vérifier leur comptabilité dans un budget partagé ; ne pas les traiter comme gratuits.
- [Solde indépendant](https://github.com/Piloxita/automaton/blob/de3e4c0853e98c55bafc5b9867a71c14b9dbbe47/src/survival/selfhosted-balance.ts) : distingue lecture inconnue et zéro, mais agrège USDC et crédits d'inférence. Nous gardons les comptes séparés.

Ses instructions décrivent l'encaissement x402 avec un facilitateur public.
Cela ne constitue pas une preuve qu'un produit se vend, que son règlement a été
testé ici, ni que les tarifs/conditions du facilitateur restent ceux du texte.
Ces conditions devront être vérifiées avant intégration.

Nous ne reprenons pas les montants de sa politique, ses hypothèses matérielles,
ses chemins personnels ou son mécanisme de survie sur solde nul. Un financement
crypto nul ne doit pas tuer un agent dont l'inférence et l'hébergement sont
financés séparément. Aucun tunnel public n'est ajouté au signataire privé.

## Améliorations réalisées dans notre version

L'ancien profil standalone supprimait `create_goal`, `get_plan` et
`complete_task` et n'injectait le suivi des tâches que lorsque l'orchestrateur
Conway était initialisé. Le réactiver intégralement aurait aussi réactivé des
chemins de financement de travailleurs et des appels auxiliaires à budgéter.

Le nouveau chemin reste dans l'unique boucle locale existante :

1. `create_goal` enregistre un objectif de travail local et son origine.
2. `plan_goal` enregistre 1 à 16 étapes, leurs dépendances et estimations.
3. `get_plan` restitue l'état et la prochaine étape exécutable, avec sa description.
4. L'agent exécute lui-même l'étape et appelle `complete_task` après vérification.
5. Le contexte de tâches est réinjecté à chaque tour, y compris après une veille.

Les dépendances non terminées empêchent la clôture d'une tâche en standalone.
Les plans invalides ou déjà présents ne créent pas de tâches partielles ni de
doublons. La reprise persiste dans les tables existantes `goals` et `task_graph`,
sans migration nouvelle. Les rapports fondés sur ces tables restent utilisables.
Une déclaration de tâche terminée n'est cependant pas une preuve indépendante
de qualité : conserver les fichiers, tests et observations associés.

Cette planification ne lance aucun autre modèle, aucun travailleur et aucun
achat. Les appels normaux de la boucle restent soumis au budget d'inférence.
Les estimations du plan ne sont pas la facture du fournisseur.
Un objectif de travail local et une mission financière approuvée sont deux
objets distincts : `goalId` dans QQOQCCP doit désigner la mission du guardian,
pas l'identifiant local choisi par l'agent. Aucun objectif local ne crée de droit
de dépense.

L'identité système standalone ne prétend plus vivre dans un sandbox Conway ni
devoir mourir faute de ses crédits. Les fournisseurs, plafonds, clés, services,
soldes et autorisations financières existants ne sont pas modifiés.

## Choisir un domaine d'activité

Le [prompt de mission proposé](prompts/GENESIS_VALUE_CREATION.fr.md) donne à
l'agent la responsabilité de comparer trois créneaux, en choisir un avec des
sources, construire un prototype et continuer ou abandonner selon des résultats.
Il ne lui impose pas arbitrairement un secteur ou un rendement.

Une première piste adaptée aux capacités observées est la surveillance et les
rapports vérifiables pour petits services web : persistance, données réelles,
historique et suivi d'incidents. C'est une hypothèse à comparer, pas une preuve
de demande. Un script de plus ou un site publié ne prouvent pas une vente.

Sans Conway, une offre peut être publiée sur un service dédié du VPS et recevoir
des USDC sur Base à l'adresse publique du guardian. Pour une vente automatisée,
il reste à implémenter et tester la tarification, la vérification du paiement,
la livraison, la tenue des reçus et les éventuels remboursements autorisés.
Ne pas livrer sur la seule base d'un header fourni par le client ou d'une
acceptation HTTP. Le serveur marchand n'a jamais besoin de la clé privée du
guardian pour recevoir ou vérifier un paiement.

Ce travail n'installe pas encore cette facturation, ne génère pas de clients et
ne garantit pas de bénéfice. L'étape suivante est la validation d'une offre
concrète avant d'investir dans l'intégration de nouveaux services.

## Installation dans le déploiement existant

La branche publiée est `research/conway-independent-runtime`, basée sur la
branche opérationnelle récente. Faire appliquer son diff par Claude dans VS Code
sur un checkout propre, en préservant les correctifs et configurations locaux
du service déployé. Sauvegarder, construire et tester avant un redémarrage ciblé
de l'agent Hetzner. Le guardian Hostinger n'a pas besoin d'être remplacé pour ces
changements de planification.

Fusionner le nouveau prompt de mission avec les contraintes existantes du
créateur, avec sauvegarde privée de `automaton.json` et remplacement atomique.
Ne pas remettre à zéro la base, le portefeuille, les budgets ou l'historique.
Ne pas approuver automatiquement une nouvelle mission financière.

Validation locale : construction runtime/CLI et typecheck réussis ; **76 fichiers,
1 879 tests réussis**, dont les nouveaux parcours de planification et de reprise
sans Conway. Tests d'inférence simulés, sans fonds ni appels commerciaux réels.
Le code des forks tiers n'a pas été exécuté. Aucun changement n'a été déployé sur
Hetzner ou Hostinger depuis cet environnement.
