# Validation de la mise à niveau

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
- Pas de réconciliation on-chain automatique ni de signataire matériel/distant.
- Pas de benchmark complet mémoire/CPU/disque de l'agent en production.
- Pas d'audit exhaustif actuel des dépendances transitives ou de leur absence de
  code malveillant ; empreintes et versions ne prouvent pas l'innocuité.
- Pas d'isolation contre un agent disposant des droits administrateur du même
  hôte. Pas de garantie réseau au point de connexion sans proxy/pare-feu adapté.
- Pas de nettoyage rétroactif automatique des secrets de l'historique ancien.

Les choix permettant de garder l'agent opérationnel et les garanties restantes
sont détaillés dans [le guide de migration et d'exploitation](SECURITY_UPGRADE.md).
Les modifications sont à revoir et commiter avant de répliquer cette version à
partir d'un clone distant ; aucun push ou commit n'a été effectué automatiquement.
