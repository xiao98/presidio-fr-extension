# presidio-fr shield (extension navigateur)

Masque les données personnelles françaises **dans votre navigateur** avant qu'elles ne partent vers ChatGPT, puis restaure les valeurs dans la réponse affichée. Aucun serveur, aucune installation Python : tout tourne dans l'extension.

```
vous tapez   : Le salarié NIR 1 85 05 78 006 084 91, mail jean@cabinet.fr, est en arrêt.
ChatGPT reçoit: Le salarié NIR {{NIR_1}}, mail {{EMAIL_1}}, est en arrêt.
vous lisez   : ... 1 85 05 78 006 084 91 ...   (placeholders restaurés à l'écran)
```

Détecté (v0.1) : NIR (clé 97), SIREN / SIRET (Luhn), IBAN FR (mod 97), e-mail, téléphone FR, passeport, plaque SIV, numéro fiscal (seulement si le message parle d'impôt).
Les règles sont le portage JavaScript du paquet Python [presidio-fr](https://github.com/xiao98/presidio-fr).

## Installer (mode développeur)

1. `chrome://extensions` → activer **Mode développeur** → **Charger l'extension non empaquetée** → choisir ce dossier.
2. Ouvrir chatgpt.com. Un toast « 🛡 3 données masquées : NIR, EMAIL, SIRET » apparaît à chaque envoi filtré.
3. L'icône de l'extension permet de désactiver le masquage et affiche le compteur.

## Comment ça marche

- `src/recognizers.js` : détection par motifs + somme de contrôle, sans réseau.
- `src/vault.js` : table `{{TYPE_n}}` ↔ valeur. Une même valeur garde le même placeholder d'un message à l'autre, le modèle peut donc y faire référence. Stockée dans `chrome.storage.session` : survit à un rechargement, disparaît à la fermeture du navigateur.
- `src/content.js` : intercepte Entrée et le bouton d'envoi, réécrit l'éditeur, relance l'envoi ; un `MutationObserver` restaure les placeholders dans les messages affichés, y compris pendant le streaming.

## Tests

```bash
npm test          # règles + vault (Node, sans navigateur)
npm run test:e2e  # extension chargée dans Chromium contre une page qui imite ChatGPT
```

Le test e2e vérifie : le texte qui quitte l'éditeur est masqué, la réponse qui renvoie les placeholders est restaurée à l'écran, la table survit à un rechargement, un message sans donnée sensible passe intact.

## Limites connues

- Sélecteurs ChatGPT (`#prompt-textarea`, `data-testid="send-button"`, `data-message-author-role`) : à re-vérifier à chaque refonte de l'interface. Le script retombe sur « l'unique zone `contenteditable` de la page » si l'id change.
- Pas encore de NER (noms, adresses) : prévu via un modèle CamemBERT quantifié exécuté dans le navigateur.
- Claude.ai et Le Chat : mêmes mécanismes, sélecteurs à ajouter.

MIT.
