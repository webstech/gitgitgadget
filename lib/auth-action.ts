import { appTokens, setAppToken } from "./auth-util";
import { isDirectory } from "./fs-util";
import { getConfig } from "./gitgitgadget-config";
import { IConfig, loadConfig, setConfig } from "./project-config";
import path from "path";

export interface authInterface {
    configRepositoryDir: string;
    config: string;
    repoOwner: string;
    repoName: string;
    orgs: string[];
    appid: string;
}

/**
 * Set an app token in the git config for use by github-helper.
 *
 * @param parms
 */

export async function handleAction(parms: authInterface): Promise<appTokens> {
    const config: IConfig = parms.config ? setConfig(await getExternalConfig(parms.config)) : getConfig();

    // Update with current values
    config.repo.name = parms.repoName;
    config.repo.owner = parms.repoOwner;
    setConfig(config);

    lintConfig(config);

    if (!(await isDirectory(parms.configRepositoryDir))) {
        throw new Error(`git WorkDir '${parms.configRepositoryDir}' not found.`);
    }

    const appID = parseInt(parms.appid, 10);
    return await setAppToken(appID, parms.orgs, parms.configRepositoryDir);
}

async function getExternalConfig(file: string): Promise<IConfig> {
    return await loadConfig(path.resolve(file));
}

function lintConfig(config: IConfig): void {
    if (!config.hasOwnProperty("project")) {
        throw new Error(`User configurations must have a 'project:'.  Not found in ${path}`);
    }

    if (!config.repo.owner.match(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i)) {
        throw new Error(`Invalid 'owner' ${config.repo.owner} in ${path}`);
    }
}
