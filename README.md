# presidio-fr shield (extension navigateur)

Masque les données personnelles françaises **dans votre navigateur** avant qu'elles ne partent vers ChatGPT, puis restaure les valeurs dans la réponse affichée. Aucun serveur, aucune installation Python : les règles et le modèle tournent dans l'extension.

```
vous tapez    : Le salarié Jean Dupont, 12 rue de la Paix, 75002 Paris, NIR 1 85 05 78 006 084 91, né le 12/03/1985. Facture du 27/04/2026.
ChatGPT reçoit: Le salarié {{PERSON_1}}, {{ADDRESS_1}}, NIR {{NIR_1}}, né le {{DOB_1}}. Facture du 27/04/2026.
vous lisez    : ... Jean Dupont ... 12 rue de la Paix ...   (placeholders restaurés à l'écran, badge 🛡 sous le message)
```

Deux couches de détection :

- **Règles** (`src/recognizers.js`, portage JS de [presidio-fr](https://github.com/xiao98/presidio-fr)) : NIR (clé 97), SIREN / SIRET (Luhn), IBAN FR (mod 97), e-mail, téléphone FR, passeport, plaque SIV, numéro fiscal (seulement en contexte fiscal).
- **Modèle local** (`src/ner.mjs`) : [Wismut/nym-pii-multilingual-small](https://huggingface.co/Wismut/nym-pii-multilingual-small) (edge-int8, 108 Mo) via transformers.js + ONNX Runtime WASM, dans un document offscreen de l'extension. Il apporte les noms, adresses et sociétés que les règles ne peuvent pas voir. Téléchargé une fois depuis Hugging Face, mis en cache par le navigateur, exécuté hors ligne ensuite. `src/nermap.js` fusionne les deux couches : les règles ont priorité sur les identifiants structurés, les dates du modèle ne sont gardées que comme dates de naissance (« né(e) le … »).

Sur [FR-PII-Bench v0](https://github.com/xiao98/presidio-fr/tree/main/eval/benchmark) (300 documents administratifs synthétiques, 2 105 entités), cette configuration obtient recall 0,96 / précision 0,97, avec 43 masquages inutiles sur 300 documents ; les règles seules restent à 0,73 de recall car elles ne voient ni les noms ni les adresses.

## Installer (mode développeur)

Télécharger `presidio-fr-shield-<version>.zip` dans [Releases](https://github.com/xiao98/presidio-fr-extension/releases) et le décompresser. Il contient déjà le bundle et le runtime WASM : rien à installer, pas de Node.

Depuis les sources : `npm install && npm run build` produit `dist/` et `vendor/` (non versionnés, ~85 Mo).

1. `chrome://extensions` → activer **Mode développeur** → **Charger l'extension non empaquetée** → choisir le dossier décompressé.
2. L'icône de l'extension affiche l'état du modèle (chargement … % / prêt). Tant qu'il charge, un envoi contenant des données est retenu, jamais envoyé en clair.
3. Ouvrir chatgpt.com. Un toast « 🛡 3 données masquées : PERSON, ADDRESS, NIR » apparaît à chaque envoi filtré.

## Comment ça marche

- `src/content.js` : intercepte Entrée et le bouton d'envoi, demande les spans au modèle, réécrit l'éditeur, vérifie la réécriture (sinon bloque l'envoi), relance l'envoi ; un `MutationObserver` restaure les placeholders dans les messages affichés, y compris pendant le streaming.
- `src/vault.js` : table `{{TYPE_n}}` ↔ valeur. Une même valeur garde le même placeholder d'un message à l'autre. Stockée dans `chrome.storage.session` : survit à un rechargement, disparaît à la fermeture du navigateur.
- `src/background.js` : crée le document offscreen qui héberge le modèle et relaie les requêtes.
- Popup : activer / désactiver, mode « afficher ce que ChatGPT a reçu », activer / désactiver le modèle, compteur.

## Tests

```bash
npm test                        # règles, vault, fusion (Node, sans navigateur ni modèle)
npm run test:ner                # modèle en Node sur FR-PII-Bench : recall / précision (télécharge le modèle)
npm run test:e2e                # extension dans Chromium contre une page qui imite ChatGPT, règles seules
PFR_E2E_NER=1 npm run test:e2e  # idem avec le vrai modèle chargé dans le navigateur (lent)
```

## Limites connues

- Sélecteurs ChatGPT (`#prompt-textarea`, `data-testid="send-button"`, `data-message-author-role`) : à re-vérifier à chaque refonte de l'interface.
- Forme administrative « NOM Prénom » en capitales : le modèle la rate dans 45 % des cas sur le benchmark ; c'est le seul point où un fine-tuning aurait un sens.
- Claude.ai et Le Chat : mêmes mécanismes, sélecteurs à ajouter.
- Fichiers joints (PDF, Excel) : non traités.

MIT.
