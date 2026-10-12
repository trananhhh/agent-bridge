const REPO = 'trananhhh/agent-bridge';
export const INSTALL_URL = `https://github.com/${REPO}/tarball/main`;
/** The commit at the tip of main, then its package.json: what gets installed is exactly what was checked. */
export const LATEST_COMMIT_URL = `https://api.github.com/repos/${REPO}/commits/main`;
export const packageUrlAt = (ref) => `https://raw.githubusercontent.com/${REPO}/${ref}/package.json`;
export const tarballAt = (ref) => `https://github.com/${REPO}/tarball/${ref}`;
/** The first release that updates itself; older machines must be updated by hand once. */
const FIRST_SELF_UPDATING = '0.8.0';
const MAX_ATTEMPTS = 2;
const parts = (v) => v.split('-')[0].split('.').map((n) => Number(n) || 0);
export function isNewer(a, b) {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}
const manualUpdate = (name) => `on that machine run \`npm install -g --prefer-online ${INSTALL_URL}\` then \`agent-bridge setup --name ${name}\``;
/**
 * Keeps agent-bridge current on this machine and makes outdated connected machines visible.
 * Every notice goes out once per release (remembered in the store), so a check every few hours never repeats itself.
 */
export function createUpdater(opts) {
    const { store, name, current } = opts;
    const once = async (key, value, text) => {
        if (store.getKv(key) === value)
            return;
        store.setKv(key, value);
        await opts.announce(text).catch(() => { });
    };
    async function updateSelf(latest, ref) {
        if (!isNewer(latest, current))
            return false;
        // Installing did not change the running version twice: stop, rather than restart every few minutes.
        const attempts = Number(store.getKv(`update_attempts:${latest}`) ?? 0);
        if (attempts >= MAX_ATTEMPTS) {
            await once('update_stuck', latest, `⚠️ ${name} could not update agent-bridge to ${latest}: it still runs ${current} after installing. ${manualUpdate(name).replace('on that machine r', 'R')}.`);
            return false;
        }
        if (opts.manualBecause) {
            await once('update_available', latest, `ℹ️ agent-bridge ${latest} is out; ${name} runs ${current} (${opts.manualBecause}). To update, ${manualUpdate(name).replace('on that machine ', '')}.`);
            return false;
        }
        try {
            opts.log('updating', { from: current, to: latest, ref });
            await opts.install(ref);
        }
        catch (err) {
            opts.log('update_failed', { to: latest, error: err.message });
            await once('update_failed', latest, `⚠️ ${name} could not update agent-bridge to ${latest}: ${err.message}`);
            return false;
        }
        store.setKv(`update_attempts:${latest}`, String(attempts + 1));
        store.setKv('updated_from', current);
        await opts.restart();
        return true;
    }
    async function checkPeers(latest) {
        for (const peer of opts.peers()) {
            const version = await opts.peerVersion(peer.url).catch(() => undefined);
            if (!version || !isNewer(latest, version))
                continue;
            const how = isNewer(FIRST_SELF_UPDATING, version) ? `It cannot update itself yet: ${manualUpdate(peer.name)}.` : 'It updates itself within a few hours.';
            await once(`peer_outdated:${peer.name}`, latest, `ℹ️ ${peer.name} runs agent-bridge ${version}; ${latest} is out. ${how}`);
        }
    }
    async function check() {
        let latest;
        try {
            latest = await opts.fetchLatest();
        }
        catch (err) {
            return opts.log('update_check_failed', { error: err.message });
        }
        if (await updateSelf(latest.version, latest.ref))
            return;
        await checkPeers(latest.version);
    }
    async function announceRestart() {
        const from = store.getKv('updated_from');
        if (!from || from === current)
            return;
        store.setKv('updated_from', '');
        await opts.announce(`⬆️ ${name} updated agent-bridge ${from} → ${current}`).catch(() => { });
    }
    return { check, announceRestart };
}
