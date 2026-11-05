# Volets du bureau

Page web pour piloter les stores des boîtiers Distech Allure UNITOUCH (V1 et V2) en Bluetooth, avec des noms lisibles.

- **iPhone** : ouvrir la page dans l'appli gratuite *Bluefy* (Safari ne gère pas le Bluetooth web).
- **Android** : ouvrir la page dans *Chrome*.

## Noms partagés

Chacun peut renommer les boîtiers et les stores depuis la page : les noms sont gardés sur son téléphone.
Pour que toute l'équipe voie les mêmes noms, copier le contenu de la section « Noms partagés » de la page
dans [`aliases.json`](aliases.json). Attention : ce dépôt est public, ces noms aussi.

## Fonctionnement

Le protocole a été reconstitué depuis l'appli officielle *my Personify* 1.9.1 (voir `protocol.js`) :

| Rôle | UUID V2 |
|---|---|
| Configuration des stores (noms des groupes) | `00010003-0000-0000-0000-00137e5a8eef` |
| État en direct des stores | `00020003-0000-0000-0000-00137e5a8eef` |
| Envoi des commandes | `00000004-0000-0000-0000-00137e5a8eef` |

Commande d'un store : 8 octets little-endian `[0x0202][décalage][valeur float32]`,
décalage `16 + 16 × groupe` pour la hauteur (en %), `24 + 16 × groupe` pour l'orientation (en degrés, de −90 à 90),
`0` pour tous les stores. Les commandes écrivent dans la table d'état en direct, au décalage de la valeur visée.

Outil non officiel, sans lien avec Distech Controls ou Acuity Brands. Les écrans nLight nTS et les boîtiers
protégés par code PIN ne sont pas pris en charge.
