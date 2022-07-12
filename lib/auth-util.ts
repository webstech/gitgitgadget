import { git, gitConfig } from "./git";
import { getConfig } from "./project-config";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

export type appTokens = Map<string, string>;

/**
 * Set an app token in the git config for use by github-helper.  The caller may want to set
 * environment variables using the returned values.
 *
 * @param appID github assigned app id
 * @param orgs set of other organizations to set tokens for.
 * @param workDir git working directory for setting config value
 * @returns appTokens map of key values naming the app tokens
 */
export async function setAppToken(appID: number, orgs: string[], workDir: string): Promise<appTokens> {
    const config = getConfig();
    const tokens: appTokens = new Map();

    let token = await set({ workDir, ...config.app });
    tokens.set(token.key, token.value);

    for (const name of orgs) {
        token = await set({ appID, name, workDir });
        tokens.set(token.key, token.value);
    }

    return tokens;
}

async function set(options: { appID: number; installationID?: number; name: string, workDir: string }):
    Promise<{ key: string, value: string }> {
    const config = getConfig();
    const appName = options.name === config.app.name ? config.app.name : config.app.altname;
    const appNameKey = `${appName}.privateKey`;
    const appNameVar = appNameKey.toUpperCase().replace(/\./, "_");
    const key = process.env[appNameVar] ? process.env[appNameVar] : await gitConfig(appNameKey, options.workDir);

    if (!key) {
        throw new Error(`Need the ${appName} App's private key`);
    }

    const client = new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: options.appID,
            privateKey: key.replace(/\\n/g, `\n`),
        },
    });

    if (options.installationID === undefined) {
        options.installationID = (
            await client.rest.apps.getRepoInstallation({
                owner: options.name,
                repo: config.repo.name,
            })
        ).data.id;
    }
    const result = await client.rest.apps.createInstallationAccessToken({ installation_id: options.installationID });
    const configKey = `${options.name !== config.app.name ? "gitgitgadget." : ""}${options.name}.githubToken`;
    await git(["config", configKey, result.data.token], { workDir: options.workDir });
    return { key: configKey, value: result.data.token };
};
