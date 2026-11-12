/** The prompts setup asks. Matches @inquirer/prompts, so tests can script the answers. */
export interface Prompter {
  input(options: {
    message: string;
    default?: string;
    validate?: (value: string) => true | string;
  }): Promise<string>;
  confirm(options: { message: string; default?: boolean }): Promise<boolean>;
  select<T extends string>(options: {
    message: string;
    choices: { name: string; value: T }[];
    default?: T;
  }): Promise<T>;
}

export async function createInquirerPrompter(): Promise<Prompter> {
  const { confirm, input, select } = await import("@inquirer/prompts");
  return {
    input: (options) => input(options),
    confirm: (options) => confirm(options),
    select: (options) => select(options),
  };
}

/** Inquirer throws this when the person presses Ctrl+C at a prompt. */
export function isPromptCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}
