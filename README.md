# presidio-fr shield (extension navigateur)

Masque les données personnelles françaises **dans votre navigateur** avant qu'elles ne partent vers ChatGPT, Claude.ai ou Le Chat (Mistral), puis restaure les valeurs dans la réponse affichée. Aucun serveur, aucune installation Python : les règles et le modèle tournent dans l'extension.

```
vous tapez    : Le salarié Jean Dupont, 12 rue de la Paix, 75002 Paris, NIR 1 85 05 78 006 084 91, né le 12/03/1985. Facture du 27/04/2026.
ChatGPT reçoit: Le salarié {{PERSON_1}}, {{ADDRESS_1}}, NIR {{NIR_1}}, né le {{DOB_1}}. Facture du 27/04/2026.
vous lisez    : ... Jean Dupont ... 12 rue de la Paix ...   (placeholders restaurés à l'écran, badge 🛡 sous le message)
```

Deux couches de détection :

- **Règles** (`src/recognizers.js`, portage JS de [presidio-fr](https://github.com/xiao98/presidio-fr)) : NIR (clé 97), SIREN / SIRET (Luhn), IBAN FR (mod 97), e-mail, téléphone FR, passeport, plaque SIV, numéro fiscal (seulement en contexte fiscal).
- **Modèle local** (`src/ner.mjs`) : [Wismut/nym-pii-multilingual-small](https://huggingface.co/Wismut/nym-pii-multilingual-small) (edge-int8, 108 Mo) via transformers.js + ONNX Runtime WASM, dans un document offscreen de l'extension. Il apporte les noms, adresses et sociétés que les règles ne peuvent pas voir. Téléchargé une fois depuis Hugging Face, mis en cache par le navigateur, exécuté hors ligne ensuite. `src/nermap.js` fusionne les deux couches : les règles ont priorité sur les identifiants structurés, les dates du modèle ne sont gardées que comme dates de naissance (« né(e) le … »).

Le décodage est en mode « recall-first » (un token est une entité dès que P(O) < 0,5, même si la masse se répartit entre plusieurs types), et une règle couvre la forme administrative « NOM Prénom » / « XIAO HAO » que le modèle rate souvent.

Sur [FR-PII-Bench v0](https://github.com/xiao98/presidio-fr/tree/main/eval/benchmark) (300 documents administratifs synthétiques, 2 105 entités), cette configuration obtient recall 0,99 / précision 0,97, avec 41 masquages inutiles sur 300 documents (noms en capitales : 0,99, contre 0,49 pour le modèle seul) ; les règles seules restent à 0,73 de recall car elles ne voient ni les noms ni les adresses.

## Pièces jointes

Un fichier choisi, glissé ou collé dans ChatGPT est remplacé par une copie masquée **avant** l'envoi, avec les mêmes placeholders que le texte (un même SIRET garde le même `{{SIRET_1}}` d'un message à un fichier) :

| Fichier | Traitement | Résultat |
|---|---|---|
| PDF avec couche texte | texte extrait ligne par ligne (pdf.js), masqué | `facture-masqué.txt` (la mise en page PDF ne peut pas être conservée) |
| PDF scanné (sans texte) | détecté | **envoi bloqué** avec message ; OCR à venir |
| Word `.docx` | paragraphes, en-têtes, pieds de page, tableaux réécrits dans le XML | `contrat-masqué.docx`, mise en page et styles conservés |
| Excel `.xlsx` | chaînes partagées, cellules texte et cellules numériques (un SIRET saisi en nombre) ; formules intactes | `clients-masqué.xlsx` |
| `.txt` `.csv` `.md` | texte | `note-masqué.txt` |
| autre (images, zip…) | | **envoi bloqué** |

Un nom coupé sur plusieurs « runs » Word (« Jean » en gras + « Dupont ») est masqué comme un seul `{{PERSON_1}}`. Limite : 25 Mo par fichier.

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
npm run test:e2e                # extension dans Chromium contre une page qui imite ChatGPT : règles seules + pièces jointes (PDF, DOCX, XLSX, scan bloqué)
PFR_E2E_NER=1 npm run test:e2e  # idem avec le vrai modèle chargé dans le navigateur (lent)
```

## Registre, licence

- **Registre (audit)** : chaque masquage ajoute une ligne (horodatage, site, message ou fichier, nombre par type). Jamais de valeur. « Exporter le registre (CSV) » dans la fenêtre de l'extension produit le fichier qu'un DPO peut classer. 5 000 lignes glissantes, stockées localement.
- **Licence** : 14 jours d'essai complets à l'installation, puis règles seules sans clé (modèle et pièces jointes désactivés). Les clés sont signées Ed25519 et vérifiées hors ligne dans le navigateur, il n'y a pas de serveur de licence. Côté vendeur : `node scripts/license.mjs keygen` une fois (coller la clé publique dans `src/license.js`), puis `node scripts/license.mjs sign <privkey.json> <email> <plan> <postes> <AAAA-MM-JJ>` par client. Le code étant MIT, la licence n'est pas une protection technique ; elle porte la facture et le support.
- **Restauration tolérante** : un modèle ou un rendu markdown écrit parfois `{{ SIRET_1 }}`, `{{SIRET\_1}}` ou `**{{SIRET_1}}**` ; toutes ces graphies sont restaurées (seule la forme canonique est produite).

## Publication

`npm run package` produit `store/presidio-fr-shield-<version>.zip` (manifest à la racine, pour le Chrome Web Store) et `-unpacked.zip` (pour « charger l'extension non empaquetée »). Le dossier de publication est dans [STORE.md](STORE.md), la politique de confidentialité dans [PRIVACY.md](PRIVACY.md).

## Limites connues

- Sélecteurs ChatGPT (`#prompt-textarea`, `data-testid="send-button"`, `data-message-author-role`) : à re-vérifier à chaque refonte de l'interface.
- Forme administrative « NOM Prénom » en capitales : le modèle la rate dans 45 % des cas sur le benchmark ; c'est le seul point où un fine-tuning aurait un sens.
- Claude.ai et Le Chat : pris en charge par des sélecteurs génériques (éditeur ProseMirror, bouton « envoyer » par aria-label) testés sur une page imitant leur structure, à confirmer sur les vrais sites.
- PDF scannés : bloqués tant que l'OCR n'est pas intégré ; PDF texte : mise en page perdue (sortie .txt).

MIT.
