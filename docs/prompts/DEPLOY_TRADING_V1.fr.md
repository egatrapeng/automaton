# Prompt pour Claude dans VS Code

Tu interviens sur mon Automaton. Déploie la branche `feature/trading-research-and-policy` du fork `egatrapeng/automaton` en conservant les correctifs locaux. Lis `docs/TRADING_V1.fr.md` et les scripts avant de les exécuter.

Accès à réutiliser dans mon VS Code :

- Hetzner : `root@2.29.140.234`, application `/opt/automaton`, service `automaton`, configuration `/root/.automaton/automaton.json`.
- Hostinger : `root@187.55.229.201`, application `/opt/wallet-guardian/app`, Compose `/opt/wallet-guardian/compose.yaml`, projet `egatrap-wallet-guardian`, services `guardian`, `netns`, `caddy`.
- Vault existant `/var/lib/guardian-state/vault` dans le volume `egatrap-wallet-guardian_state` ; ne pas initialiser un nouveau portefeuille.
- Wallet financé attendu : `0x2c967b8B4e84217967418B3e1F6940BEeE5961c8`. Owner MetaMask : `0x9922fa69c8a4d4d77825f28000c901453d34189a`.
- Guardian privé : `https://wallet.egatrap.com:8443`. Dashboard existant : `https://wallet.egatrap.com`.

Le mode réel est autorisé pour ETH/WETH–USDC sur Base, sur la poche du wallet, sans accord humain par trade et sans ajouter un plafond de perte quotidien. Les pertes peuvent consommer cette poche. Ne change ni le budget Claude, ni les limites de services existantes, ni les retraits owner, ni les droits d'administration de l'agent. Ne force aucun trade de démonstration.

1. Inspecte les répertoires, commits locaux, Compose effectif, montages, état des services et sauvegardes privées. Conserve le RUNBOOK de production. Ne journalise aucune clé, configuration brute ou variable secrète. Ne fais aucun reset destructeur ni remplacement de la topologie réseau.
2. Intègre la branche en conservant tous les correctifs locaux. Vérifie tests/compilation si la fusion introduit des différences. Exécute `bash scripts/deploy-trading-guardian.sh --mode live` sur Hostinger. Le diagnostic public doit réussir avant activation ; sur erreur, rapporte la source en échec sans inventer de solde ou enlever les contrôles de transaction.
3. Exécute `bash scripts/deploy-trading-runtime.sh` sur Hetzner. Vérifie l'instance unique, l'activation des quatre skills, le heartbeat de rapport, la connexion au bon guardian et l'absence de changement des budgets.
4. Raccorde le dashboard existant : trouve son backend/proxy observer et son authentification actuels, ajoute uniquement les GET `/v1/trading` et `/v1/trading/view` côté serveur et un lien « Trading ». Conserve les jetons sur le backend ; aucun secret dans le navigateur. Ajoute le coût quotidien Claude depuis le rapport Hetzner si son canal privé de lecture le permet ; sinon affiche explicitement « indisponible ». Distingue portefeuille réel, simulation, frais estimés, dépôts externes, PnL, drawdown, exposition, ordre incertain et date du relevé. Aucune donnée fictive.
5. Vérifie que le navigateur non authentifié est refusé, qu'un observer ne peut pas POST, que le rapport et le journal sont privés et que l'UI affiche le vrai mode et l'heure réelle. Vérifie les contrats/chaîne avec `trading-doctor` et l'état du premier cycle ; un `hold` est un résultat valide, pas un échec à contourner.
6. Vérifie que `rentroyal`, `rentroyal-api`, `egatrap-etat`, `uptime-kuma`, `jam-web` et `jam-db` ont gardé leurs conteneurs, ports et état. Ne lance aucun prune, upgrade OS ou redémarrage Docker global. Pour le dashboard, modifie et recharge uniquement son composant nécessaire avec sauvegarde ; préserve le Caddy du jeu.

Livre les commits réellement déployés, modes, contrôles effectués, état du premier cycle, chemin des sauvegardes privées et URL de consultation. Ne prétends pas qu'un achat a été confirmé sans reçu. Si un accès manque, termine les étapes indépendantes et indique précisément le blocage. Ne transmets aucune clé financée vers Hetzner ou mon PC.
