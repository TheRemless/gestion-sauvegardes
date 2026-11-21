// Sauvegarde de la base Gestion, lancée chaque nuit par .github/workflows/sauvegarde.yml (et à la main depuis l'onglet Actions).
//
// 1. Connexion directe à la base (pooler Supabase, mode session) avec le rôle « sauvegarde_gestion » de la migration 66 : il n'a aucun droit sur
//    les tables, il ne peut qu'appeler sauvegarde_tables(), sauvegarde_table(), sauvegarde_schema() et sauvegarde_noter().
// 2. Export au même format que la sauvegarde du Mac (sauvegarde-lib.mjs : manifeste, empreintes, schéma), vérification, chiffrement AES-256-GCM.
// 3. Écriture de sauvegardes/gestion-AAAA-MM-JJ.gsb (date de Bangkok), relecture du fichier écrit (déchiffré puis vérifié), rotation
//    (30 quotidiennes et 12 mensuelles).
// 4. Résultat noté dans la base par sauvegarde_noter() : Gestion affiche un bandeau aux administrateurs après 30 heures sans réussite.
//
// Secrets du dépôt : SAUVEGARDE_DB_MOT_DE_PASSE (rôle sauvegarde_gestion) et SAUVEGARDE_PHRASE (phrase de chiffrement, la même que celle du Mac).
// Rien n'est jamais affiché : ni donnée, ni phrase, ni mot de passe. Seuls les nombres de lignes et le nom du fichier sortent dans le journal.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { chiffrer, dechiffrer, serialiser, deserialiser, verifier, nomSauvegarde, retention } from "./sauvegarde-lib.mjs";

const PROJET = process.env.SAUVEGARDE_PROJET || "lkxqcmzeidlyssoqmqkh";
const HOTES = (process.env.SAUVEGARDE_HOTES || "aws-0-eu-west-1.pooler.supabase.com,aws-1-eu-west-1.pooler.supabase.com").split(",").map((x) => x.trim()).filter(Boolean);
const DOSSIER = path.resolve(process.env.SAUVEGARDE_DOSSIER || "sauvegardes");
const motDePasse = process.env.SAUVEGARDE_DB_MOT_DE_PASSE || "";
const phrase = process.env.SAUVEGARDE_PHRASE || "";
const sha256 = (texte) => crypto.createHash("sha256").update(texte).digest("hex");
const jourBangkok = (d = new Date()) => new Date(d.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);

async function connecter() {
  let derniere = null;
  for (const host of HOTES) {
    const client = new pg.Client({ host, port: 5432, database: "postgres", user: `sauvegarde_gestion.${PROJET}`, password: motDePasse, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 20000, statement_timeout: 120000 });
    try {
      await client.connect();
      console.log(`Connecté par ${host}.`);
      return client;
    } catch (err) {
      derniere = err;
      console.log(`Connexion refusée par ${host} : ${String(err.message).slice(0, 120)}`);
      await client.end().catch(() => {});
    }
  }
  throw new Error(`connexion impossible (${String(derniere && derniere.message).slice(0, 150)})`);
}

async function exporter(client, maintenant) {
  const liste = (await client.query("select table_schema, table_name from sauvegarde_tables()")).rows;
  const tables = {};
  const manifest = { version: 1, projet: PROJET, date: maintenant.toISOString(), tables: {}, total_lignes: 0, fichiers_joints: 0 };
  for (const { table_schema: s, table_name: t } of liste) {
    const { rows } = await client.query("select sauvegarde_table($1, $2) as donnees", [s, t]);
    const lignes = rows[0].donnees || [];
    tables[`${s}.${t}`] = lignes;
    manifest.tables[`${s}.${t}`] = { lignes: lignes.length, sha256: sha256(JSON.stringify(lignes)) };
    manifest.total_lignes += lignes.length;
  }
  manifest.fichiers_joints = (tables["storage.objects"] || []).length;
  const schema = (await client.query("select sauvegarde_schema() as s")).rows[0].s;
  return { manifest, tables, schema };
}

async function principal() {
  if (!motDePasse || !phrase) throw new Error("secret manquant : SAUVEGARDE_DB_MOT_DE_PASSE ou SAUVEGARDE_PHRASE");
  if (phrase.length < 20) throw new Error("phrase de chiffrement trop courte (20 caractères au moins)");
  const maintenant = new Date();
  const client = await connecter();
  try {
    try {
      const sauvegarde = await exporter(client, maintenant);
      const problemes = verifier(sauvegarde);
      if (problemes.length) throw new Error(`sauvegarde incohérente : ${problemes.slice(0, 3).join(" ; ")}`);
      fs.mkdirSync(DOSSIER, { recursive: true });
      const nom = nomSauvegarde(jourBangkok(maintenant));
      const fichier = path.join(DOSSIER, nom);
      fs.writeFileSync(fichier, chiffrer(serialiser(sauvegarde), phrase));
      // Relecture du fichier écrit : il se déchiffre avec la phrase et son contenu correspond au manifeste.
      const relu = deserialiser(dechiffrer(fs.readFileSync(fichier), phrase));
      const p2 = verifier(relu);
      if (p2.length || relu.manifest.total_lignes !== sauvegarde.manifest.total_lignes) throw new Error(`relecture du fichier en échec : ${p2.slice(0, 3).join(" ; ")}`);
      const { supprimer } = retention(fs.readdirSync(DOSSIER), jourBangkok(maintenant));
      for (const n of supprimer || []) fs.rmSync(path.join(DOSSIER, n));
      const m = sauvegarde.manifest;
      console.log(`OK ${nom} : ${m.total_lignes} lignes, ${Object.keys(m.tables).length} tables, ${fs.statSync(fichier).size} octets.${m.fichiers_joints ? ` ${m.fichiers_joints} fichier(s) joint(s) ne sont pas dans la sauvegarde.` : ""}${(supprimer || []).length ? ` Rotation : ${(supprimer || []).length} ancienne(s) supprimée(s).` : ""}`);
      await client.query("select sauvegarde_noter(true, $1, $2, null)", [m.total_lignes, nom]);
    } catch (err) {
      await client.query("select sauvegarde_noter(false, null, null, $1)", [String(err.message).slice(0, 300)]).catch(() => {});
      throw err;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

principal().catch((err) => {
  console.error(`ÉCHEC : ${String(err.message).slice(0, 300)}`);
  process.exit(1);
});
