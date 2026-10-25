import { describe, expect, test } from "bun:test";
import { configSchema } from "../shared/config";
import type { Gateway, Protocol } from "./contracts";
import { ConfigurationError } from "./errors";
import { discoverProjects, resolveProject } from "./projects";
import { RequestError } from "./protocol";

function fixture() {
  const protocol = {
    projects: async () => [{ id: 1, key: "ONE", name: "First" }, { id: 2, key: "TWO", name: "Second" }],
    repositories: async (id: number) => {
      if (id === 1) throw new RequestError(403, "private diagnostic");
      return [{ id: 4, provider: "gitea", fullName: "team/app", webUrl: "https://forge.test/team/app" }];
    },
  } as Protocol;
  const gateway = {
    repositories: async () => [{ paseoProjectId: "native-app", name: "App", repository: "/registered/app", common: "/registered/app/.git", remotes: ["https://forge.test/team/app"] }],
  } as Gateway;
  return { protocol, gateway };
}

describe("project discovery boundaries", () => {
  test("a project-level permission denial does not hide other projects or their matches", async () => {
    const { protocol, gateway } = fixture();
    const projects = await discoverProjects(protocol, gateway);
    expect(projects[0]).toMatchObject({ id: 1, repositoryMatch: { status: "unavailable" } });
    expect(JSON.stringify(projects[0])).not.toContain("private diagnostic");
    expect(projects[1]).toMatchObject({ id: 2, repositoryMatch: { status: "matched", candidate: { repository: "/registered/app" } } });
  });
  test("a failed catalog cannot be presented as a unique match", async () => {
    const { protocol, gateway } = fixture();
    gateway.repositories = async () => { throw new Error("private filesystem details"); };
    const projects = await discoverProjects(protocol, gateway);
    expect(projects[1]?.repositoryMatch?.status).toBe("unavailable");
    await expect(resolveProject(configSchema.parse({}), protocol, gateway, "2")).rejects.toBeInstanceOf(ConfigurationError);
    expect(JSON.stringify(projects)).not.toContain("private filesystem details");
  });
  test("a read permission denial still permits a configured explicit override", async () => {
    const { protocol, gateway } = fixture();
    const config = configSchema.parse({ projects: { "1": { repository: "/explicit/app" } } });
    expect((await resolveProject(config, protocol, gateway, "1")).repository).toBe("/explicit/app");
  });
  test("cancellation during catalog inspection is propagated instead of converted into configuration failure", async () => {
    const { protocol, gateway } = fixture();
    const controller = new AbortController();
    const reason = new Error("Fixture cancellation");
    gateway.repositories = async () => { controller.abort(reason); throw reason; };
    await expect(resolveProject(configSchema.parse({}), protocol, gateway, "2", controller.signal)).rejects.toBe(reason);
  });
});
