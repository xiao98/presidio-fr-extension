# Chrome Web Store — dossier de publication

Tout ce qu'il faut coller dans le formulaire du [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). Prérequis côté compte : inscription développeur (5 $ une fois), e-mail de contact vérifié dans l'onglet « Account ».

## Paquet

`npm run build && npm run package` produit `store/presidio-fr-shield-<version>.zip` avec `manifest.json` à la racine (le Web Store refuse un zip dont le manifest est dans un sous-dossier). Contenu : manifest, src/, dist/, vendor/, icons/, popup, offscreen. Taille ≈ 20 Mo compressés.

## Fiche

**Nom** : presidio-fr shield

**Résumé (≤ 132 caractères)** :
Masque noms, adresses, NIR, SIRET, IBAN et fichiers avant l'envoi à ChatGPT, Claude ou Le Chat. Tout reste dans votre navigateur.

**Catégorie** : Productivité (ou « Vie privée et sécurité » si proposée). **Langue** : français.

**Description** :

Vous collez des dossiers clients dans ChatGPT ? presidio-fr shield remplace les données personnelles françaises par des placeholders avant que le message ne quitte votre navigateur, puis restaure les vraies valeurs dans la réponse affichée. Le modèle ne voit jamais le nom, l'adresse ou le numéro de sécurité sociale ; vous, si.

Détecté : noms et prénoms (y compris la forme administrative « NOM Prénom »), adresses postales, sociétés, dates de naissance, numéros de sécurité sociale (NIR, avec clé de contrôle), SIREN / SIRET (Luhn), IBAN, numéros fiscaux, plaques d'immatriculation, passeports, e-mails, téléphones.

Pièces jointes : PDF (couche texte), Word et Excel sont masqués avant l'envoi. Word et Excel sont réécrits en place, mise en page et formules conservées. Un PDF scanné sans texte est bloqué plutôt qu'envoyé en clair.

Comment ça marche : deux couches locales, des règles avec sommes de contrôle et un modèle de langue multilingue (120 Mo, téléchargé une fois, exécuté hors ligne en WebAssembly). Un même SIRET garde le même placeholder d'un message à l'autre et d'un fichier à l'autre, le modèle peut donc raisonner dessus. Un badge sous chaque message confirme ce qui a été masqué ; un mode « vue du modèle » montre exactement ce qui est parti.

Sites : chatgpt.com, claude.ai, chat.mistral.ai.

Rien ne sort de votre navigateur : pas de serveur, pas de compte, pas de télémétrie. Code source MIT : github.com/xiao98/presidio-fr-extension. Mesuré sur FR-PII-Bench (300 documents administratifs français) : 99 % de rappel, 97 % de précision.

Conçu pour les experts-comptables, avocats, cabinets RH et toute personne qui manipule des données de tiers avec un assistant IA (RGPD, art. 28 et 44 : la transmission elle-même est le risque ; ici elle n'a pas lieu).

## Captures (1280×800 ou 640×400, PNG, 1 à 5)

À prendre sur le vrai chatgpt.com avec des données fictives :
1. Message envoyé avec badge « valeurs masquées avant l'envoi » sous la bulle.
2. Même conversation en mode « vue du modèle » : les placeholders `{{PERSON_1}}`, `{{SIRET_1}}` visibles.
3. Fenêtre de l'extension : réglages, compteur, état du modèle.
4. Toast après dépôt d'un PDF : « facture.pdf → facture-masqué.txt : 6 données masquées ».

Icône de fiche : `icons/icon128.png`. Image promotionnelle (440×280) facultative.

## Confidentialité (onglet Privacy)

- **Single purpose** : Masquer localement les données personnelles contenues dans les messages et fichiers envoyés aux assistants IA ChatGPT, Claude et Le Chat, et restaurer leur affichage.
- **Permission `storage`** : réglages et compteurs sans contenu (local) ; table placeholder ↔ valeur en mémoire de session, effacée à la fermeture du navigateur.
- **Permission `offscreen`** : document d'arrière-plan qui héberge le modèle de détection (WebAssembly) et l'analyse des fichiers joints, pour qu'ils restent chargés entre les pages.
- **Host permissions huggingface.co / hf.co** : téléchargement unique des poids du modèle de détection (données, pas du code). Aucune donnée utilisateur n'est envoyée.
- **Content scripts chatgpt.com, claude.ai, chat.mistral.ai** : lire le texte en cours d'envoi et les fichiers joints pour les masquer ; restaurer les placeholders dans l'affichage.
- **Code distant** : non. Tout le code JavaScript et WebAssembly est inclus dans le paquet.
- **Données collectées** : aucune (cocher « ne collecte pas de données utilisateur »).
- **Politique de confidentialité** : https://github.com/xiao98/presidio-fr-extension/blob/main/PRIVACY.md

## Points que la revue peut soulever

- *Pourquoi un téléchargement de 120 Mo ?* Le modèle de détection des noms et adresses ; désactivable dans la fenêtre, les règles restent actives. Mentionné dans la description.
- *Pourquoi lire tous les messages sur ces sites ?* Le masquage ne peut se faire qu'au moment de l'envoi ; rien n'est stocké ni transmis.
- *`wasm-unsafe-eval` dans la CSP* : nécessaire à ONNX Runtime (WebAssembly) ; aucun `eval` JavaScript.

## Après publication

- Lien d'installation à donner aux testeurs à la place du zip.
- Les mises à jour passent par le même dashboard : nouveau zip, version incrémentée dans `manifest.json`, revue en général en moins de 24 h pour une mise à jour sans nouvelle permission.
