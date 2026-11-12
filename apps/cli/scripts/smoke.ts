// Runs the built CLI the way a user does, to catch a build that compiles but doesn't start:
// a missing file in dist, a bad import, or a dependency left out of package.json.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function run(
  args: string[],
  { expectCode = 0, expectText }: { expectCode?: number; expectText: string },
) {
  let stdout = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", stdio: "pipe" });
  } catch (caught) {
    const error = caught as { status?: number; stdout?: string; stderr?: string };
    code = error.status ?? 1;
    stdout = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  if (code !== expectCode || !stdout.includes(expectText)) {
    console.error(
      `lgtmoose ${args.join(" ")}: exit ${code}, wanted ${expectCode} and "${expectText}"\n${stdout}`,
    );
    process.exit(1);
  }
  console.log(`ok  lgtmoose ${args.join(" ")}`);
}

run(["--help"], { expectText: "Usage: lgtmoose <command>" });
run(["--version"], { expectText: "0.0.0" });
run(["setup", "--help"], { expectText: "Usage: lgtmoose setup" });
run(["deploy", "--help"], { expectText: "Usage: lgtmoose deploy" });
run(["destroy", "--help"], { expectText: "Usage: lgtmoose destroy" });
run(["frobnicate"], { expectCode: 1, expectText: 'Unknown command "frobnicate"' });

// --help never loads the real dependencies (AWS SDKs, inquirer), so import them directly.
for (const module of ["../dist/setup/deps.js", "../dist/deploy/deps.js"]) {
  await import(new URL(module, import.meta.url).href);
  console.log(`ok  import ${module}`);
}
