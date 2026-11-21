# Sauvegardes de la base Gestion

Chaque nuit à 2 h (heure de Bangkok), une GitHub Action sauvegarde toute la base de Gestion (gestion.zwaldtravelplanner.com) et range le fichier chiffré dans `sauvegardes/`. On garde les 30 dernières sauvegardes quotidiennes, plus une par mois sur les 12 derniers mois.

- **Chiffrement.** Chaque fichier `gestion-AAAA-MM-JJ.gsb` est chiffré en AES-256-GCM avec la phrase de chiffrement. Sans cette phrase, il est illisible, y compris pour quelqu'un qui accède à ce dépôt.
- **Contenu.** Toutes les tables de Gestion, les comptes de connexion et la liste des fichiers joints. Les fichiers eux-mêmes (photos, PDF) restent dans le stockage Supabase et ne sont pas dans la sauvegarde.
- **Accès à la base.** Le rôle `sauvegarde_gestion` (migration 66 de Gestion) n'a aucun droit sur les tables. Il ne peut qu'appeler les fonctions de sauvegarde et noter son résultat.
- **Alerte.** Si aucune sauvegarde n'a réussi depuis plus de 30 heures, Gestion affiche un bandeau rouge aux administrateurs. GitHub envoie aussi un e-mail à chaque passage en échec.

## La phrase de chiffrement

Elle est gardée à trois endroits :
1. dans le gestionnaire de mots de passe de Jérémy (entrée « Sauvegardes Gestion ») ;
2. sur papier, chez Jérémy ;
3. dans le secret `SAUVEGARDE_PHRASE` de ce dépôt. GitHub s'en sert pour chiffrer, mais personne ne peut la relire.

**Sans la phrase, aucune restauration n'est possible.** Si elle doit changer un jour, gardez l'ancienne aussi : les anciennes sauvegardes restent chiffrées avec elle.

## Lancer une sauvegarde à la main

Onglet **Actions**, « Sauvegarde Gestion », bouton **Run workflow**. Le journal donne le nombre de lignes et le nom du fichier, jamais une donnée.

## Restaurer

Il faut un ordinateur avec Node 20 ou plus et la phrase de chiffrement.

1. **Récupérer le dépôt.**
   ```bash
   git clone https://github.com/TheRemless/gestion-sauvegardes.git && cd gestion-sauvegardes
   ```
2. **Vérifier le fichier.** La commande déchiffre la sauvegarde, contrôle son contenu et affiche le nombre de lignes par table. Elle ne touche à aucune base. Sur un Mac où la phrase est dans le trousseau (« Sauvegardes Gestion »), elle la lit toute seule. Sinon, tapez-la sans qu'elle s'affiche :
   ```bash
   read -rs "GESTION_SAUVEGARDE_PHRASE?Phrase : " && export GESTION_SAUVEGARDE_PHRASE && echo
   node outils/restaurer.mjs sauvegardes/gestion-2026-11-22.gsb
   ```
3. **Écrire le script de rechargement.** Ce fichier contient des données personnelles en clair : supprimez-le après usage.
   ```bash
   node outils/restaurer.mjs sauvegardes/gestion-2026-11-22.gsb --sql restauration.sql
   ```
4. **Recharger la base.** Le schéma doit exister avant les données : sur une base neuve, appliquez d'abord le schéma et les migrations de Gestion (dépôt Site_Anais, `docs/gestion/`). Exécutez ensuite `restauration.sql` sur la base à reconstruire. **Il vide les tables avant de les recharger** : ne l'exécutez jamais sur une base en service dont vous voulez garder le contenu.
5. Supprimez `restauration.sql` et effacez la phrase de la session : `unset GESTION_SAUVEGARDE_PHRASE`.

Le détail de l'étape 4 (ordre du schéma, comptes, séquences) est dans `docs/gestion/sauvegarde/README.md` du dépôt Site_Anais.
