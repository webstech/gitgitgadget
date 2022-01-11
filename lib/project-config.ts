export interface IConfig {
    repo: {
        name: string;
        owner: string;
        owners: string[];
        branches: string[];
        trackingBranches: string[];
        closingBranches: string[];
        host: string;
    },
    mailrepo: {
        name: string;
        owner: string;
        branches: string[];
        host: string;
    },
    app: {
        appid: number;
        installationID: number;
         name: string;
         altname: string | undefined;
    },
    lint: {
        maxcommitsignore?: string[];
        maxcommits: number;
    },
    user: {
        allowUserAsLogin: boolean;
    }
};

const defaultConfig: IConfig = {
    repo: {
        name: "git",
        owner: "gitgitgadget",
        owners: ["gitgitgadget", "git", "dscho"],
        branches: ["maint", "seen"],
        trackingBranches: ["maint", "seen", "master", "next"],
        closingBranches: ["maint", "master"],
        host: "github.com",
    },
    mailrepo: {
        name: "git",
        owner: "gitgitgadget",
        branches: ["maint", "seen"],
        host: "lore.kernel.org",
    },
    app: {
        appid: 12836,
        installationID: 195971,
        name: "gitgitgadget",
        altname: "gitgitgadget-git"
    },
    lint: {
        maxcommitsignore: [
            "https://github.com/gitgitgadget/git/pull/923"
        ],
        maxcommits: 30,
    },
    user: {
        allowUserAsLogin: false,
    }

};

let config = defaultConfig;

export function getConfig(): IConfig { return config;}
export function setConfig(newConfig: IConfig): IConfig {
    config = newConfig;
    return config;
}