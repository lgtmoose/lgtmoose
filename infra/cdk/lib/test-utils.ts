import { App } from "aws-cdk-lib";
import type { Profile } from "./network-stack.js";

/** An App that skips asset bundling, so template tests don't run esbuild for every synth. */
export function appWithoutBundling(): App {
  return new App({ context: { "aws:cdk:bundling-stacks": [] } });
}

/** Synthesizing is the slow part of stack tests: build each profile once and share the result. */
export function memoizeByProfile<T>(build: (profile: Profile) => T): (profile: Profile) => T {
  const built = new Map<Profile, T>();
  return (profile) => {
    if (!built.has(profile)) built.set(profile, build(profile));
    return built.get(profile) as T;
  };
}
