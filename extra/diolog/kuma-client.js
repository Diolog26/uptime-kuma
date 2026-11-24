/*
 * Diolog fork: a minimal Uptime Kuma socket client for the setup and provisioning scripts.
 * Kuma has no REST API for configuration; its own UI drives everything over socket.io, so these
 * scripts use the same events the UI does.
 */
const { io } = require("socket.io-client");

/**
 * Connect to a Kuma server.
 * @param {string} url e.g. http://127.0.0.1:3001 or https://status.diolog.app
 * @returns {Promise<{socket: import("socket.io-client").Socket, call: Function, next: Function, close: Function}>} client
 */
async function connect(url) {
    const socket = io(url, { transports: ["websocket"], reconnection: false, timeout: 20000 });
    // Kuma registers its event handlers only after it has sent "info" to the new socket, so an
    // event emitted on "connect" can arrive before anything is listening and is never answered.
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Kuma at ${url} sent no "info" within 30s`)), 30000);
        socket.once("info", () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once("connect_error", (e) => {
            clearTimeout(timer);
            reject(new Error(`Cannot reach Kuma at ${url}: ${e.message}`));
        });
    });

    /**
     * Emit an event whose last argument is Kuma's callback, and resolve with its reply.
     * @param {string} event socket event
     * @param {...unknown} args arguments before the callback
     * @returns {Promise<any>} the callback's argument
     */
    const call = (event, ...args) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Kuma did not answer "${event}" within 30s`)), 30000);
            socket.emit(event, ...args, (reply) => {
                clearTimeout(timer);
                resolve(reply);
            });
        });

    /**
     * Wait for the next server-pushed event.
     * @param {string} event socket event
     * @returns {Promise<any>} its first argument
     */
    const next = (event) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Kuma did not send "${event}" within 30s`)), 30000);
            socket.once(event, (data) => {
                clearTimeout(timer);
                resolve(data);
            });
        });

    return { socket, call, next, close: () => socket.close() };
}

/**
 * Throw unless a Kuma callback reply reports success.
 * @param {string} what description for the error
 * @param {{ok: boolean, msg?: string}} reply Kuma reply
 * @returns {any} the reply
 */
function ensureOk(what, reply) {
    if (!reply || !reply.ok) {
        throw new Error(`${what} failed: ${reply ? reply.msg : "no reply"}`);
    }
    return reply;
}

/**
 * Read all of stdin as a string with the trailing newline removed.
 * @returns {Promise<string>} stdin
 */
async function readStdin() {
    let data = "";
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data.replace(/\r?\n$/, "");
}

module.exports = { connect, ensureOk, readStdin };
