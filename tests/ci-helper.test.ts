import { afterAll, beforeAll, expect, jest, test } from "@jest/globals";
import { CIHelper } from "../lib/ci-helper";
import { GitNotes } from "../lib/git-notes";
import {
     GitHubGlue, IGitHubUser, IPRComment, IPRCommit, IPullRequestInfo,
} from "../lib/github-glue";
import { IMailMetadata } from "../lib/mail-metadata";
import { testSmtpServer } from "test-smtp-server";
import { testCreateRepo, TestRepo } from "./test-lib";
import { IConfig, getConfig, setConfig } from "../lib/project-config";

jest.setTimeout(180000);

const eMailOptions = {
    smtpserver: new testSmtpServer(),
    smtpOpts: ""
};

beforeAll((): void => {
    eMailOptions.smtpserver.startServer(); // start listening
    eMailOptions.smtpOpts =
        `{port: ${eMailOptions.smtpserver.getPort()
        }, secure: true, tls: {rejectUnauthorized: false}}`;
});

afterAll((): void => {
    eMailOptions.smtpserver.stopServer(); // terminate server
});

// Mocking class to replace GithubGlue with mock of GitHubGlue

class TestCIHelper extends CIHelper {
    public ghGlue: GitHubGlue;      // not readonly reference
    public addPRCommentCalls: string[][]; // reference mock.calls
    public updatePRCalls: string[][]; // reference mock.calls
    public addPRLabelsCalls: Array<[_: string, labels: string[]]>;

    public constructor(workDir: string, debug = false, gggDir = ".") {
        super(workDir, debug, gggDir);
        this.testing = true;
        this.ghGlue = this.github;

        const commentInfo = { id: 1, url: "ok" };
        const addPRComment = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<{id: number; url: string}> => commentInfo );
        this.ghGlue.addPRComment = addPRComment;
        this.addPRCommentCalls = addPRComment.mock.calls;

        const updatePR = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<number> => 1 );
        this.ghGlue.updatePR = updatePR;
        this.updatePRCalls = updatePR.mock.calls;

        const addPRLabels = jest.fn( async (_: string, labels: string[]):
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<string[]> => labels );
        this.ghGlue.addPRLabels = addPRLabels;
        this.addPRLabelsCalls = addPRLabels.mock.calls;

        // need keys to authenticate
        // this.ghGlue.ensureAuthenticated = async (): Promise<void> => {};
    }

    public setGHGetPRInfo(o: IPullRequestInfo): void {
        this.ghGlue.getPRInfo = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPullRequestInfo> => o );
    }

    public setGHGetPRComment(o: IPRComment): void {
        this.ghGlue.getPRComment = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPRComment> => o );
    }

    public setGHGetPRCommits(o: IPRCommit[]): void {
        this.ghGlue.getPRCommits = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IPRCommit[]> => o );
    }

    public setGHGetGitHubUserInfo(o: IGitHubUser): void {
        this.ghGlue.getGitHubUserInfo = jest.fn( async ():
            // eslint-disable-next-line @typescript-eslint/require-await
            Promise<IGitHubUser> => o );
    }

    public addMaxCommitsException(pullRequestURL: string): void {
        this.maxCommitsExceptions.add(pullRequestURL);
    }

    public removeMaxCommitsException(pullRequestURL: string): void {
        this.maxCommitsExceptions.delete(pullRequestURL);
    }
}

// Create three repos.
// worktree is a local copy for doing updates and has the config
// info that would normally be in the gitgitgadget repo.  To ensure
// testing isolation, worktree is NOT the repo used for git clone
// tests.  That work is done in gggLocal.

// gggRemote represents the master on github.

// gggLocal represents the empty repo to be used by gitgitgadget.  It
// is empty to ensure nothing needs to be present (worktree would
// have objects present).

async function setupRepos(instance: string):
    Promise <{ worktree: TestRepo; gggLocal: TestRepo; gggRemote: TestRepo }> {
    const worktree = await testCreateRepo(__filename, `-work-cmt${instance}`);
    const gggLocal = await testCreateRepo(__filename, `-git-lcl${instance}`);
    const gggRemote = await testCreateRepo(__filename, `-git-rmt${instance}`);

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    await gggLocal.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // set needed config
    await worktree.git([
        "config", "--add", "gitgitgadget.workDir", gggLocal.workDir,
    ]);
    await worktree.git([
        "config", "--add", "gitgitgadget.publishRemote",
        "https://github.com/gitgitgadget/git",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpUser", "joe_user@example.com",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpHost", "localhost",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpPass", "secret",
    ]);

    await worktree.git([
        "config", "--add", "gitgitgadget.smtpOpts", eMailOptions.smtpOpts,
    ]);

    const notes = new GitNotes(gggRemote.workDir);
    await notes.set("", {allowedUsers: ["ggg", "user1"]}, true);

    // Initial empty commit
    const commitA = await gggRemote.commit("A");
    expect(commitA).not.toBeUndefined();

    // Set up fake upstream branches
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "seen"]);

    return { worktree, gggLocal, gggRemote };
}

/**
 * Check the mail server for an email.
 *
 * @param messageId string to search for
 */
async function checkMsgId(messageId: string): Promise<boolean> {
    const mails = eMailOptions.smtpserver.getEmails();

    for (const mail of mails) {
        const parsed = await mail.getParsed();
        if (parsed.messageId?.match(messageId)) {
            return true;
        }
    }

    return false;
}

test("identify merge that integrated some commit", async () => {
    const repo = await testCreateRepo(__filename);

    /*
     * Create a branch structure like this:
     *
     * a - b ----- c - d
     *   \       /   /
     *   | e ----- f
     *   \       /
     *     g - h
     */
    const commitA = await repo.commit("a");
    const commitG = await repo.commit("g");
    const commitH = await repo.commit("h");
    await repo.git(["reset", "--hard", commitA]);
    const commitE = await repo.commit("e");
    const commitF = await repo.merge("f", commitH);
    await repo.git(["reset", "--hard", commitA]);
    const commitB = await repo.commit("b");
    const commitC = await repo.merge("c", commitE);
    const commitD = await repo.merge("d", commitF);
    await repo.git(["update-ref", "refs/remotes/upstream/seen", commitD]);

    const ci = new CIHelper(repo.workDir, true);
    expect(commitB).not.toBeUndefined();
    expect(await ci.identifyMergeCommit("seen", commitG)).toEqual(commitD);
    expect(await ci.identifyMergeCommit("seen", commitE)).toEqual(commitC);
    expect(await ci.identifyMergeCommit("seen", commitH)).toEqual(commitD);
});

test("identify upstream commit", async () => {
    // initialize test worktree and gitgitgadget remote
    const worktree = await testCreateRepo(__filename, "-worktree");
    const gggRemote = await testCreateRepo(__filename, "-gitgitgadget");

    // re-route the URLs
    await worktree.git(["config", `url.${gggRemote.workDir}.insteadOf`,
                        "https://github.com/gitgitgadget/git"]);

    // Set up fake upstream branches
    const commitA = await gggRemote.commit("A");
    expect(commitA).not.toBeUndefined();
    await gggRemote.git(["branch", "maint"]);
    await gggRemote.git(["branch", "next"]);
    await gggRemote.git(["branch", "seen"]);

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // "Contribute" it via a PullRequest
    const pullRequestURL = "https://example.com/pull/123";
    const messageID = "fake-1st-mail@example.com";
    const notes = new GitNotes(worktree.workDir);
    await notes.appendCommitNote(commitB, messageID);
    const bMeta = {
        messageID,
        originalCommit: commitB,
        pullRequestURL,
    } as IMailMetadata;
    await notes.set(messageID, bMeta);

    // "Apply" the patch, and merge it
    await gggRemote.newBranch("gg/via-pull-request");
    const commitBNew = await gggRemote.commit("B");
    await gggRemote.git(["checkout", "seen"]);
    await gggRemote.git(["merge", "--no-ff", "gg/via-pull-request"]);

    // Update the `mail-to-commit` notes ref, at least the part we care about
    const mail2CommitNotes = new GitNotes(gggRemote.workDir,
                                          "refs/notes/mail-to-commit");
    await mail2CommitNotes.setString(messageID, commitBNew);

    // "publish" the gitgitgadget notes
    await worktree.git(["push", gggRemote.workDir, notes.notesRef]);

    const ci = new TestCIHelper(worktree.workDir);
    expect(await ci.identifyUpstreamCommit(commitB)).toEqual(commitBNew);

    expect(await ci.updateCommitMapping(messageID)).toBeTruthy();
    const bMetaNew = await notes.get<IMailMetadata>(messageID);
    expect(bMetaNew).not.toBeUndefined();
    expect(bMetaNew?.originalCommit).toEqual(commitB);
    expect(bMetaNew?.commitInGitGit).toEqual(commitBNew);
});

test("handle comment allow basic test", async () => {
    const { worktree, gggLocal } = await setupRepos("a1");

    // Ready to start testing
    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",              // set in setupRepos
        body: "/allow  user2",
        prNumber,
    };
    const user = {
        email: "user2@example.com",
        login: "user2",
        name: "User Two",
        type: "basic",
    };

    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/is now allowed to use/);
});

test("handle comment allow fail invalid user", async () => {
    const { worktree, gggLocal } = await setupRepos("a2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow  bad_@@@@",
        prNumber,
    };

    ci.setGHGetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/is not a valid GitHub username/);
});

test("handle comment allow no public email", async () => {
    const { worktree, gggLocal } = await setupRepos("a3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const comment = {
        author: "ggg",
        body: "/allow   bad",
        prNumber,
    };
    const user: IGitHubUser = {
        email: null,
        login: "noEmail",
        name: "no email",
        type: "basic",
    };

    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/is now allowed to use/);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/no public email address set/);
});

test("handle comment allow already allowed", async () => {
    const { worktree, gggLocal } = await setupRepos("a4");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow  ggg",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/already allowed to use/);
});

test("handle comment allow no name specified (with trailing white space)",
     async () => {
    const { worktree, gggLocal } = await setupRepos("a5");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/allow   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "not so bad",
        type: "basic",
    };
    const prInfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/already allowed to use/);
});

test("handle comment disallow basic test", async () => {
    const { worktree, gggLocal } = await setupRepos("d1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  user1 ",
        prNumber,
    };
    const user = {
        email: "user1@example.com",
        login: "user1",
        name: "not so bad",
        type: "basic",
    };

    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/is no longer allowed to use/);
});

test("handle comment disallow was not allowed", async () => {
    const { worktree, gggLocal } = await setupRepos("d2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/disallow  unknown1 ",
        prNumber,
    };

    ci.setGHGetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/already not allowed to use/);
});

test("handle comment submit not author", async () => {
    const { worktree, gggLocal } = await setupRepos("s1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prInfo = {
        author: "ggNOTg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/Only the owner of a PR can submit/);
});

test("handle comment submit not mergeable", async () => {
    const { worktree, gggLocal } = await setupRepos("s2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "bad@example.com",
        login: "ggg",
        name: "ee cummings",
        type: "basic",
    };
    const prInfo = {
        author: "ggg",
        baseCommit: "A",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Super body",
        hasComments: true,
        headCommit: "B",
        headLabel: "somebody:master",
        mergeable: false,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Do Not Submit a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1])
        .toMatch(/does not merge cleanly/);
});

test("handle comment submit email success", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("s3");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\r\nnew line";
    // add template to master repo
    await gggRemote.commit("temple", ".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BA55FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Submit ok\n\nSuccinct message\n\nSigned-off-by: x",
        parentCount: 1,
    }];
    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: `Super body\r\n${template}\r\nCc: Copy One <copy@cat.com>\r\n`
            + "Cc: Copy Two <copycat@cat.com>",
        hasComments: true,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Submit a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetPRCommits(commits);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(/Submitted as/);

    const msgId = ci.addPRCommentCalls[0][1].match(/\[(.*)\]/);
    expect(msgId).not.toBeUndefined();
    if (msgId && msgId[1]) {
        const msgFound = await checkMsgId(msgId[1]);
        expect(msgFound).toBeTruthy();
    }
});

test("handle comment preview email success", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("p1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const template = "fine template\nnew line";
    await gggRemote.commit("temple", ".github//PULL_REQUEST_TEMPLATE.md",
                           template);
    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "preview@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BA55FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Submit ok\n\nSigned-off-by: x",
        parentCount: 1,
    }];
    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "There will be a submit email and a preview email.",
        hasComments: true,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetPRCommits(commits);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(/Submitted as/);

    const msgId1 = ci.addPRCommentCalls[0][1].match(/\[(.*)\]/);
    expect(msgId1).not.toBeUndefined();
    if (msgId1 && msgId1[1]) {
        const msgFound1 = await checkMsgId(msgId1[1]);
        expect(msgFound1).toBeTruthy();
    }

    comment.body = " /preview";
    ci.setGHGetPRComment(comment);
    await ci.handleComment("gitgitgadget", 433865360); // do it again
    expect(ci.addPRCommentCalls[1][1])
        .toMatch(/Preview email sent as/);

    const msgId2 = ci.addPRCommentCalls[0][1].match(/\[(.*)\]/);
    expect(msgId2).not.toBeUndefined();
    if (msgId2 && msgId2[1]) {
        const msgFound2 = await checkMsgId(msgId2[1]);
        expect(msgFound2).toBeTruthy();
    }

    await ci.handleComment("gitgitgadget", 433865360); // should still be v2

    const msgId3 = ci.addPRCommentCalls[0][1].match(/\[(.*)\]/);
    expect(msgId3).not.toBeUndefined();
    if (msgId3 && msgId3[1]) {
        const msgFound3 = await checkMsgId(msgId3[1]);
        expect(msgFound3).toBeTruthy();
    }
});

test("handle push/comment too many commits fails", async () => {
    const { worktree, gggLocal, gggRemote } = await setupRepos("pu1");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git([
        "fetch", worktree.workDir,
        `refs/heads/master:${pullRequestRef}/head`,
        `refs/heads/master:${pullRequestRef}/merge`,
    ]); // fake merge

    const commits: IPRCommit[] = [];
    for (let i = 0; i < 40; i++) {
        commits.push({
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: `${i}abc123`,
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: `commit ${i}`,
            parentCount: 1,
        });
    }
    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "preview@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - too many commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    const failMsg = `The pull request has ${commits.length} commits.`;
    // fail for too many commits on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRCommentCalls[0][1]).toMatch(failMsg);
    ci.addPRCommentCalls.length = 0;

    // fail for too many commits on submit
    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(failMsg);
    ci.addPRCommentCalls.length = 0;

    ci.addMaxCommitsException(prInfo.pullRequestURL);
    await ci.handleComment("gitgitgadget", 433865360);
    // There will still be a comment, but about upper-case after prefix
    expect(ci.addPRCommentCalls).toHaveLength(1);
    expect(ci.addPRCommentCalls[0][1]).not.toMatch(failMsg);
    ci.removeMaxCommitsException(prInfo.pullRequestURL);
    ci.addPRCommentCalls.length = 0;

    // fail for too many commits on preview
    comment.body = " /preview";
    ci.setGHGetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(failMsg);
    ci.addPRCommentCalls.length = 0;

    // fail for too many commits push new user
    prInfo.author = "starfish";
    comment.author = "starfish";
    user.login = "starfish";
    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);
    ci.setGHGetPRCommits(commits);

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRCommentCalls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRCommentCalls[1][1]).toMatch(failMsg);
    expect(ci.addPRLabelsCalls[0][1]).toEqual(["new user"]);
});

test("handle push/comment merge commits fails", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD1FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 2,
    }];

    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetPRCommits(commits);
    ci.setGHGetGitHubUserInfo(user);

    // fail for merge commits on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRCommentCalls[0][1]).toMatch(commits[0].commit);
    ci.addPRCommentCalls.length = 0;

    // fail for merge commits on submit
    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(commits[0].commit);
    ci.addPRCommentCalls.length = 0;

    // fail for merge commits on preview
    comment.body = " /preview";
    ci.setGHGetPRComment(comment);

    await ci.handleComment("gitgitgadget", 433865360);
    expect(ci.addPRCommentCalls[0][1]).toMatch(commits[0].commit);
    ci.addPRCommentCalls.length = 0;

    // fail for merge commits push new user
    prInfo.author = "starfish";
    comment.author = "starfish";
    user.login = "starfish";

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRCommentCalls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRCommentCalls[1][1]).toMatch(commits[0].commit);
    expect(ci.addPRLabelsCalls[0][1]).toEqual(["new user"]);
    ci.addPRCommentCalls.length = 0;

    // Test Multiple merges
    commits.push({
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD2FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 1,
    });
    commits.push({
        author: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        commit: "BAD3FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Merge a commit",
        parentCount: 2,
    });

    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

    expect(ci.addPRCommentCalls[0][1]).toMatch(/Welcome/);
    expect(ci.addPRCommentCalls[1][1]).toMatch(commits[0].commit);
    expect(ci.addPRCommentCalls[1][1]).not.toMatch(commits[1].commit);
    expect(ci.addPRCommentCalls[1][1]).toMatch(commits[2].commit);
    ci.addPRCommentCalls.length = 0;

});

test("disallow no-reply emails", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu2");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [{
        author: {
            email: "random@users.noreply.github.com",
            login: "random",
            name: "random",
        },
        commit: "BAD1FEEDBEEF",
        committer: {
            email: "ggg@example.com",
            login: "ggg",
            name: "e. e. cummings",
        },
        message: "Using ineligible email address",
        parentCount: 1,
    }];

    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetPRCommits(commits);
    ci.setGHGetGitHubUserInfo(user);

    // fail for commits with fake email on push
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);

});

// Basic tests for ci-helper - lint tests are in commit-lint.tests.ts

test("basic lint tests", async () => {
    const { worktree, gggLocal, gggRemote} = await setupRepos("pu4");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    const commitA = await gggRemote.revParse("HEAD");
    expect(commitA).not.toBeUndefined();

    // Now come up with a local change
    // this should be in a separate repo from the worktree
    await worktree.git(["pull", gggRemote.workDir, "master"]);
    const commitB = await worktree.commit("b");

    // get the pr refs in place
    const pullRequestRef = `refs/pull/${prNumber}`;
    await gggRemote.git(
        [ "fetch", worktree.workDir,
          `refs/heads/master:${pullRequestRef}/head`,
          `refs/heads/master:${pullRequestRef}/merge`]); // fake merge

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/submit   ",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };
    const commits = [
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD1FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Message has no description",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD2FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Missing blank line is bad\nhere\nSigned-off-by: x",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "F00DFEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "Successful test\n\nSigned-off-by: x",
            parentCount: 1,
        },
        {
            author: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            commit: "BAD5FEEDBEEF",
            committer: {
                email: "ggg@example.com",
                login: "ggg",
                name: "e. e. cummings",
            },
            message: "tests: This should be lower case\n\nSigned-off-by: x",
            parentCount: 1,
        },
    ];

    const prInfo = {
        author: "ggg",
        baseCommit: commitA,
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - merge commits.",
        commits: commits.length,
        hasComments: false,
        headCommit: commitB,
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetPRCommits(commits);
    ci.setGHGetGitHubUserInfo(user);

    // fail for commits with lint errors
    await expect(ci.handlePush("gitgitgadget", 433865360)).
        rejects.toThrow(/Failing check due/);
    expect(ci.addPRCommentCalls[0][1]).toMatch(commits[0].commit);
    expect(ci.addPRCommentCalls[0][1]).toMatch(/too short/);
    expect(ci.addPRCommentCalls[1][1]).toMatch(commits[1].commit);
    expect(ci.addPRCommentCalls[1][1]).toMatch(/empty line/);
    expect(ci.addPRCommentCalls[2][1]).toMatch(commits[3].commit);
    expect(ci.addPRCommentCalls[2][1]).toMatch(/lower case/);

});

test("Handle comment cc", async () => {
    const {worktree, gggLocal} = await setupRepos("cc");

    const ci = new TestCIHelper(gggLocal.workDir, false, worktree.workDir);
    const prNumber = 59;

    // GitHubGlue Responses
    const comment = {
        author: "ggg",
        body: "/cc \"Some Body\" <sbody@example.com>",
        prNumber,
    };
    const user = {
        email: "ggg@example.com",
        login: "ggg",
        name: "e. e. cummings",
        type: "basic",
    };

    const prInfo = {
        author: "ggg",
        baseCommit: "foo",
        baseLabel: "gitgitgadget:next",
        baseOwner: "gitgitgadget",
        baseRepo: "git",
        body: "Never seen - no cc.",
        commits: 1,
        hasComments: false,
        headCommit: "bar",
        headLabel: "somebody:master",
        mergeable: true,
        number: prNumber,
        pullRequestURL: "https://github.com/gitgitgadget/git/pull/59",
        title: "Preview a fun fix",
    };

    ci.setGHGetPRInfo(prInfo);
    ci.setGHGetPRComment(comment);
    ci.setGHGetGitHubUserInfo(user);

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePRCalls[0][2]).toMatch(/Some Body/);
    ci.updatePRCalls.length = 0;

    comment.body = "/cc \"A Body\" <abody@example.com>, "
        + "\"S Body\" <sbody@example.com>";

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePRCalls[0][2]).toMatch(/A Body/);
    expect(ci.updatePRCalls[1][2]).toMatch(/S Body/);
    ci.updatePRCalls.length = 0;

    // email will not be re-added to list
    prInfo.body = "changes\r\n\r\ncc: <abody@example.com>";

    await ci.handleComment("gitgitgadget", prNumber);

    expect(ci.updatePRCalls[0][2]).toMatch(/S Body/);
    expect(ci.updatePRCalls).toHaveLength(1);
});

test("test config updates", () => {
    let config: IConfig = getConfig();
    console.log(JSON.stringify(config, null, 2));
    const defaultConfig: IConfig = {
        repo: {
            name: "updated",
            owner: "gitgitgadget",
            owners: ["gitgitgadget", "git", "dscho"],
            branches: ["maint", "seen"],
            trackingBranches: ["master"],
            closingBranches: ["master"],
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
            maxcommits: 10,
        },
        user: {
            allowUserAsLogin: false,
        }
    };
    config = setConfig(defaultConfig);
    console.log(JSON.stringify(config, null, 2));
});
