# Politique de confidentialité — presidio-fr shield

*Dernière mise à jour : 1er octobre 2026*

## En une phrase

presidio-fr shield ne collecte, ne transmet et ne stocke aucune donnée en dehors de votre navigateur. Il n'y a pas de serveur presidio-fr.

## Ce que fait l'extension

Sur chatgpt.com, claude.ai et chat.mistral.ai, l'extension lit le texte que vous êtes sur le point d'envoyer et les fichiers que vous joignez, y détecte des données personnelles (noms, adresses, numéros de sécurité sociale, SIREN/SIRET, IBAN, e-mails, téléphones, dates de naissance, etc.), les remplace par des placeholders (`{{NIR_1}}`) avant l'envoi, puis restaure les valeurs d'origine dans l'affichage de la réponse.

## Où vont les données

- **Détection** : règles et modèle de langue exécutés localement, dans le navigateur (WebAssembly). Aucun texte ni fichier n'est envoyé à un tiers par l'extension.
- **Table de correspondance** placeholder ↔ valeur : stockée dans `chrome.storage.session`, c'est-à-dire en mémoire du navigateur, effacée à sa fermeture. Elle n'est jamais synchronisée ni exportée.
- **Compteurs** (nombre de données masquées par type) : `chrome.storage.local`, sur votre appareil uniquement, sans contenu.
- **Modèle de détection** : au premier lancement, l'extension télécharge le modèle `Wismut/nym-pii-multilingual-small` (environ 120 Mo) depuis huggingface.co. Cette requête ne contient aucune donnée personnelle ; le modèle est ensuite mis en cache par le navigateur et exécuté hors ligne. Vous pouvez désactiver le modèle dans la fenêtre de l'extension (les règles seules restent actives).

## Ce que l'extension ne fait pas

- Pas de télémétrie, pas d'analytics, pas de compte, pas d'identifiant.
- Pas de lecture d'autres sites que les trois listés ci-dessus.
- Pas de code distant : tout le code exécuté est embarqué dans l'extension (le modèle téléchargé est un fichier de poids, pas du code).

## Permissions demandées

| Permission | Pourquoi |
|---|---|
| `storage` | compteurs et réglages (local), table placeholder ↔ valeur (session) |
| `offscreen` | document d'arrière-plan qui héberge le modèle et l'analyse des fichiers |
| `https://huggingface.co/*`, `https://*.hf.co/*` | téléchargement unique du modèle |
| Scripts sur chatgpt.com, claude.ai, chat.mistral.ai | intercepter l'envoi et restaurer l'affichage |

## Vos droits

L'extension ne détenant aucune donnée vous concernant, il n'y a rien à exporter ni à supprimer de notre côté. Désinstaller l'extension efface ses réglages ; fermer le navigateur efface la table de session.

## Contact

Questions : ouvrir une issue sur https://github.com/xiao98/presidio-fr-extension.

---

# Privacy policy — presidio-fr shield (English)

presidio-fr shield collects, transmits and stores nothing outside your browser. There is no presidio-fr server.

On chatgpt.com, claude.ai and chat.mistral.ai it reads the text you are about to send and the files you attach, detects French personal data locally (rules + a language model running in WebAssembly), replaces it with placeholders before sending, and restores the original values in the displayed reply.

- Placeholder ↔ value table: `chrome.storage.session` (browser memory, cleared when the browser closes), never synced or exported.
- Counters only (no content): `chrome.storage.local`.
- Model: downloaded once from huggingface.co (about 120 MB, the request carries no personal data), cached by the browser, run offline. It can be switched off in the popup.
- No telemetry, no analytics, no accounts, no remote code.

Permissions: `storage` (settings, counters, session table), `offscreen` (background document hosting the model and file parsing), huggingface.co hosts (one-time model download), content scripts on the three chat sites (intercept sending, restore display).

Contact: https://github.com/xiao98/presidio-fr-extension/issues
