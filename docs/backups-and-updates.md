# Backups and updates

## Your data

Everything lives in the `data` folder: your images and a database file. To back it up, stop Pinnery first (`docker compose stop`), copy the folder, then start it again. Copying it while it's running can give a broken database. Export from Settings → Import/Export gives you a zip of your boards that you can import into any Pinnery.

## Updating

Pull the new image and restart: `docker compose pull && docker compose up -d`. Your data is upgraded automatically, and a backup is made first when needed.
