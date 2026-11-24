/*
 * Diolog fork: create Kuma's admin account before the instance is reachable from the internet.
 *
 * Kuma's first-run setup is open to whoever reaches it first, so the status cell's bootstrap runs
 * this inside the Kuma container against localhost, and only then starts the TLS proxy.
 *
 *   node extra/diolog/setup-admin.js <username> < password-file
 *
 * Exits 0 when the admin was created or an admin already exists; non-zero on any failure.
 */
const { connect, ensureOk, readStdin } = require("./kuma-client");

(async () => {
    const username = process.argv[2];
    if (!username) {
        throw new Error("usage: node extra/diolog/setup-admin.js <username> < password-file");
    }
    const password = await readStdin();
    if (password.length < 20) {
        throw new Error("refusing an admin password shorter than 20 characters");
    }

    const kuma = await connect(process.env.KUMA_URL || "http://127.0.0.1:3001");
    try {
        const needSetup = await kuma.call("needSetup");
        if (!needSetup) {
            console.log("setup-admin: an admin account already exists; nothing to do");
            return;
        }
        ensureOk("setup", await kuma.call("setup", username, password));
        console.log(`setup-admin: created admin "${username}"`);
    } finally {
        kuma.close();
    }
})().catch((e) => {
    console.error(`setup-admin: ${e.message}`);
    process.exit(1);
});
