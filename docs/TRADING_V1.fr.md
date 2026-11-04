# Trading V1 : intégration et déploiement

La V1 fournit un moteur autonome ETH/WETH–USDC sur **Base (8453)**, une étude continue, une simulation prospective, des données de risque et un rapport lisible par le dashboard. La clé financée reste sur le guardian Hostinger. Le moteur fonctionne aussi quand Automaton dort ou a épuisé son budget Claude.

## Périmètre et autonomie

| Élément | Implémentation |
| --- | --- |
| Uniswap | Exécution native Uniswap V3, pool WETH/USDC à 0,05 %, routeur et contrats Base fixes. Adaptation des principes des skills upstream ; leur CLI de signature n'est pas installée. |
| Bankr | Skill local de recherche et outil `trading_token_research` : DexScreener et indicateurs GoPlus, taxes, concentration des détenteurs listés, inconnues explicites. Les services Bankr, Alchemy ou Zerion payants ne sont pas installés. |
| Coinbase AgentKit | Vrai SDK publié **0.10.4**, dépendances verrouillées dans un sous-projet facultatif. Cinq actions Pyth/DeFiLlama en lecture seule ; aucun compte CDP, portefeuille ou signataire SDK. |
| Étude | Trois stratégies SMA : 5/20, 10/40 et 20/60. Sélection sur 60 % chronologiques, validation sur les 40 % suivants, frais et slippage simulés, comparaison à une détention. |
| Simulation | Portefeuille virtuel persistant, décisions datées, frais, résultat et baisse maximale. Distinct de l'étude historique et des ordres réels. |
| Réel | Ordre automatique seulement si l'étude retenue a un résultat net positif, au moins celui du benchmark, avec assez d'exécutions simulées. Aucun accord humain par ordre après activation `live`. |
| Amélioration / capital faible | Nouvelle étude toutes les 15 minutes, sans LLM ; conservation de la réserve de gas, passage à une vérification horaire si le capital est trop faible. Pas de suppression du runtime en cas de solde nul. |
| Rapports | API JSON, vue HTML authentifiée, audit SQLite, notifications existantes et copie JSON sur Hetzner toutes les cinq minutes sans réveil du modèle. |

Le capital est **la totalité des actifs pris en charge du portefeuille guardian**, moins la réserve de gas et les autorisations de services encore valides. Allocation par défaut : 100 %. **Aucun plafond quotidien de perte de marché n'est ajouté** (`maxDailyLossBps: null`) : toute cette poche peut subir des pertes. Les limites de services existantes — 5 USDC par achat, 10 USDC/h et 25 €/24 h — et le budget Claude restent distincts et inchangés.

La V1 ne trade ni actions tokenisées, ni jetons arbitraires, ni dérivés ou levier. L'analyse d'un autre jeton Base ne lui donne aucun droit de trading. L'ETH natif déjà présent peut être vendu en USDC ; il n'est donc pas nécessaire de le transférer sur le wallet local de l'agent.

## Limites de l'étude et comptabilité

La fenêtre publique contient au plus 300 bougies de cinq minutes, soit environ 25 heures. C'est une première heuristique opérationnelle, pas une preuve de rentabilité durable. Un seul remplissage hors échantillon est requis par défaut ; cette condition minimale ne donne aucune confiance statistique. Les sélections répétées peuvent surajuster les marchés récents. Aucun pourcentage de probabilité de gain n'est annoncé.

Les signaux historiques sont exécutés à l'ouverture suivante, jamais au cours déjà connu de la bougie qui les produit. L'étude sélectionne ses paramètres uniquement sur l'entraînement. Les données manquantes, discontinues, périmées ou invalides provoquent une attente. Si Coinbase consolide ETH-USDC dans ETH-USD, le moteur convertit les bougies USD avec le **cours courant USDC/USD** de DeFiLlama, frais et hypothèse affichés. Il ne prétend pas disposer d'un historique de change USDC/USD. Cours hors 0,98–1,02 USD ou périmé : arrêt des nouvelles décisions.

Le résultat réel estimé distingue les flux externes des gains du moteur : un dépôt n'est pas un bénéfice. La valorisation des flux entre observations, les retraits et certains frais de rollup restent approximatifs ; ce rapport n'est pas une comptabilité fiscale. Les coûts d'inférence sont l'estimation locale du tracker, distincte de la facture Anthropic. L'API du guardian n'a pas accès à la facture Claude : le rapport Hetzner ajoute cette section à partir de sa propre base.

GoPlus et DexScreener ne certifient pas un contrat. Les détenteurs listés peuvent inclure pools, burn et vaults. Une information absente reste inconnue. Une cotation ne prouve pas qu'une vente aboutira.

## Contrôles conservés et raisons

Les validations répétitives de chaque trade sont remplacées par la politique installée sur Hostinger. Le jeton de l'agent ne permet pas d'activer le mode réel ni de modifier cette politique. Une injection de prompt ne peut choisir ni calldata, ni routeur, ni jeton inconnu, ni destination de swap. Tous les produits du swap reviennent au wallet guardian. Les retraits externes conservent l'approbation exacte existante : ils ne sont pas nécessaires au trading autonome.

Chaque transaction utilise Base uniquement, une autorisation ERC-20 du montant exact si nécessaire, un devis Uniswap comparé au marché indépendant (écart maximal 3 %), un minimum de sortie (slippage maximal 1 %), une date limite et un devis récent. Les frais Base estimés, y compris le rollup avec marge, doivent rester sous 0,0001 ETH par transaction. La réserve initiale minimale est 0,0003 ETH. Ce sont des estimations de frais, pas une garantie de frais L1 futurs. Les swaps d'ETH natif incluent `refundETH` pour restituer un reliquat du routeur.

Au maximum 12 cycles ayant signé sur 24 heures ; les autorisations seules et transactions revertées comptent aussi. L'identifiant de bougie est unique. Le hash signé est enregistré **avant** la diffusion ; un timeout ne provoque aucune rediffusion. Douze confirmations sont requises. Une opération incertaine bloque les nouvelles signatures du wallet jusqu'à rapprochement ; le redémarrage consulte ses reçus sans reprendre à l'aveugle une stratégie inachevée. Une autorisation exacte au routeur connu peut rester après un échec du swap ; il n'existe pas d'autorisation illimitée.

Une autorisation de dépense de service valide garde ses USDC réservés. Un verrou SQLite transactionnel coordonne trades, retraits et nouvelles signatures de services. Ces contrôles empêchent les doubles dépenses et les détournements sans imposer une confirmation humaine à chaque échange.

## Vérifications reproductibles

Depuis le dépôt, avec Node 22 et pnpm 10.28.1 :

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm exec vitest run --maxWorkers=2 --minWorkers=1
npm ci --prefix integrations/coinbase-agentkit --ignore-scripts --no-audit --no-fund
npm test --prefix integrations/coinbase-agentkit
bash -n scripts/deploy-trading-guardian.sh scripts/deploy-trading-runtime.sh
```

Après construction de l'image, `bash scripts/test-trading-image.sh NOM_IMAGE` vérifie le serveur compilé, SQLite, les commandes de politique et le rôle observer dans un volume jetable, sans réseau ni port public. Aucun volume existant n'est utilisé.

Les tests utilisent des prix, RPC, reçus et signatures simulés. Ils couvrent notamment les swaps dans les deux sens, ETH natif, autorisations exactes, mauvaise chaîne, contrat/pool absent, liquidité nulle, frais excessifs, nonce concurrent, prix incohérent, service réservé, retrait concurrent, signature persistée avant diffusion, timeout/redémarrage, reverts, flux externes, observer sans droit d'écriture et conservation des configurations lors du déploiement. Le test AgentKit importe réellement le SDK et exécute une action avec un faux HTTP.

Aucun test avec les fonds de production n'a été fait depuis cet environnement. Les API publiques de marché et RPC seront vérifiées depuis Hostinger par `trading-doctor`, sans clé et sans signature, avant l'activation.

## Déployer sur Hostinger

Ces commandes sont destinées au terminal **Hostinger**, ou à Claude dans VS Code connecté par SSH. Elles réutilisent le projet `egatrap-wallet-guardian`, le fichier `/opt/wallet-guardian/compose.yaml`, les services `guardian`, `netns`, `caddy` et le volume existant. Ne jamais relancer `init` sur ce portefeuille.

```bash
cd /opt/wallet-guardian/app
git status --short
git fetch origin feature/trading-research-and-policy
git merge --ff-only FETCH_HEAD
bash scripts/deploy-trading-guardian.sh --mode live
```

Si le dépôt comporte des correctifs locaux ou a divergé, les conserver et les intégrer dans un commit avant de relancer. Ne pas utiliser `reset --hard`, `clean` ou un stash oublié. La branche part de la version opérationnelle `1663998`.

`--mode live` autorise les échanges réels sur la poche du wallet dès qu'une étude est éligible. Pour observer d'abord sans ordre, remplacer par `--mode paper`. Il n'est pas nécessaire de faire passer un ordre forcé pour prouver que le daemon tourne.

Le script construit une image portant le commit, vérifie la topologie Compose et les données publiques, arrête **seulement guardian**, sauvegarde le vault dans un répertoire privé, installe la politique, modifie seulement l'image et le délai d'arrêt de `guardian`, puis le redémarre et vérifie son API. Il ne recrée pas `netns` ou `caddy`, n'ajoute pas de port et ne modifie pas les services RentRoyal, Jam, Uptime Kuma, les règles réseau ou les certificats.

La sauvegarde du vault contient la clé : garder `/opt/wallet-guardian/backups/` privé, ne pas l'ajouter à Git ni la copier sur Hetzner. Les Compose avec overrides existants ou une autre topologie demandent une adaptation manuelle conservant ces protections ; le script s'arrête avant modification.

Vérifications après démarrage :

```bash
cd /opt/wallet-guardian
docker compose -p egatrap-wallet-guardian -f compose.yaml ps
docker compose -p egatrap-wallet-guardian -f compose.yaml exec -T guardian node dist/wallet-guardian/cli.js trading-report --directory /var/lib/guardian-state/vault
docker compose -p egatrap-wallet-guardian -f compose.yaml logs --tail 80 guardian
```

Le premier rapport peut être `not_observed` pendant les lectures initiales. `hold` signifie que le moteur a étudié les données et n'a pas trouvé de nouveau trade admissible. `unavailable` est une erreur de source ou de préparation, pas un solde nul. `paused` / transaction `uncertain` demande de rapprocher le reçu ; ne pas changer d'identifiant pour recommencer.

## Déployer sur Hetzner

Après le guardian, depuis le terminal **Hetzner** :

```bash
cd /opt/automaton
git status --short
git fetch origin feature/trading-research-and-policy
git merge --ff-only FETCH_HEAD
bash scripts/deploy-trading-runtime.sh
systemctl status automaton --no-pager
journalctl -u automaton -n 60 --no-pager
```

Le script vérifie le répertoire du service, installe les dépendances verrouillées, compile dans un répertoire temporaire, installe et teste l'observateur AgentKit séparé, arrête seulement `automaton`, sauvegarde sa configuration/base/dist, installe quatre skills et active les outils/rapports locaux, puis échange le `dist` compilé et redémarre. Prompt, modèle, budgets, destinations, jetons et droits d'administration sont conservés. Aucun `sudo` supplémentaire, compte CDP ou clé de trading n'est créé.

L'option `--without-agentkit` permet de conserver uniquement les adaptateurs natifs ; le trading autonome ne dépend pas du SDK. Ne pas lancer `npm install` AgentKit dans le projet racine : ses dépendances sont isolées sous `integrations/coinbase-agentkit/`. Le verrou couvre les versions installées, pas un audit exhaustif de leurs dépendances. Les scripts d'installation npm sont désactivés. Le warning bigint sur les bindings natifs est attendu : le SDK utilise son repli JavaScript pour ces actions de données. Le sous-processus reçoit les variables de proxy/CA, aucune clé applicative, et rejette les hôtes inconnus et les écritures HTTP ; ce n'est pas un sandbox OS contre une dépendance arbitrairement malveillante.

Le rapport est ensuite écrit en mode 0600 à côté de `state.db`, normalement `/root/.automaton/trading-report.json`. Le journal de notifications existant reçoit aussi les événements trading.

## Raccorder le dashboard existant

Le code du dashboard déployé par VS Code ne figure pas dans ce dépôt. Les points d'intégration sont prêts ; ce raccordement doit être appliqué à son backend existant :

| Route guardian | Usage | Accès |
| --- | --- | --- |
| `GET /v1/trading` | Rapport JSON réel/papier, exposition, étude, frais, derniers ordres et heures de lecture | Observer ou agent |
| `GET /v1/trading/view` | Page HTML rendue côté serveur, sans JavaScript externe, texte échappé et liens BaseScan | Observer ou agent |
| `POST /v1/trading/tick` | Demande d'un cycle **seulement s'il est dû** ; aucun paramètre de stratégie/destination accepté | Agent uniquement |

Étendre le proxy de lecture **déjà authentifié** du dashboard à ces deux GET ; conserver le jeton observer uniquement dans son backend et la protection réseau actuelle du guardian. Ajouter un lien « Trading » vers la vue HTML ou afficher son JSON dans les cartes existantes. Aucun bouton d'ordre ou de changement de politique n'est nécessaire. Le navigateur ne doit recevoir ni jeton client ni jeton observer. Ne pas exposer directement 8787 et ne pas remplacer le Caddy de RentRoyal.

Pour afficher le coût Claude, le backend peut ajouter la section `inference` du rapport Hetzner à son propre rendu ; la vue guardian affiche « indisponible » si cette donnée n'a pas été ajoutée. Distinguer les périodes de ce coût quotidien et du résultat trading cumulé. Afficher l'heure réelle du rapport et signaler une lecture ancienne ; conserver les états indisponibles, simulés, confirmés et incertains.

Un [prompt opérateur VS Code](prompts/DEPLOY_TRADING_V1.fr.md) reprend les accès connus et les étapes de raccordement sans fournir de secret.

## Arrêter et reprendre

Arrêt immédiat des nouvelles signatures sur Hostinger, sans redémarrer les autres services :

```bash
cd /opt/wallet-guardian
docker compose -p egatrap-wallet-guardian -f compose.yaml stop --timeout 130 guardian
```

Après arrêt, désactiver le trading puis redémarrer les fonctions de services/retraits existantes :

```bash
docker compose -p egatrap-wallet-guardian -f compose.yaml run --rm --no-deps guardian trading-configure --directory /var/lib/guardian-state/vault --mode off
docker compose -p egatrap-wallet-guardian -f compose.yaml up -d --no-deps guardian
```

Une transaction déjà diffusée peut encore être confirmée. Ne jamais restaurer une ancienne base, effacer un verrou ou revenir à un ancien signataire qui ignore une opération incertaine. Conserver la base actuelle et son hash, puis inspecter les reçus. Les sauvegardes de configuration ne constituent pas une autorisation à réémettre une transaction.

Pour changer seulement les paramètres de trading, créer un JSON privé sur Hostinger contenant les champs à changer, arrêter `guardian`, puis utiliser `trading-configure --mode live --file /chemin/prive/politique.json` et redémarrer uniquement ce service. Les valeurs sont validées ; la commande sauvegarde le fichier précédent et ne signe rien. Aucune API distante ne permet ce changement.

Provenance des références et empreintes des skills locaux : [trading-skills.lock.json](../integrations/trading-skills.lock.json).
