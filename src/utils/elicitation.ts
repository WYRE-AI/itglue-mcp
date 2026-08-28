/**
 * Elicitation helpers for MCP tool handlers.
 * All functions gracefully return null if the client doesn't support elicitation.
 */
import { getServerRef } from "./server-ref.js";

export interface ElicitOption {
  value: string;
  label: string;
}

/**
 * Record that an elicitation prompt could not be delivered.
 *
 * Failing here is expected, not exceptional: any client that doesn't declare
 * the elicitation capability makes `elicitInput()` throw, and the MCP gateway
 * does not proxy server-initiated requests at all — so every gateway-mode
 * request takes this path. Returning null and degrading is therefore correct.
 *
 * What was wrong was doing it *silently*: a bare `catch {}` turned "the user
 * could not be asked" into "the user said nothing", callers widened their
 * query, and nothing anywhere recorded that a prompt had been dropped. Logged
 * to stderr because stdout is the stdio transport's protocol channel.
 */
function noteElicitationUnavailable(reason: unknown): void {
  const detail = reason instanceof Error ? reason.message : String(reason);
  console.error(
    `[itglue-mcp] elicitation unavailable (${detail}) — continuing without user input; ` +
      `callers fall back to an unscoped request.`
  );
}

/**
 * Ask the user to select from a list of options.
 */
export async function elicitSelection(
  message: string,
  fieldName: string,
  options: ElicitOption[]
): Promise<string | null> {
  const server = getServerRef();
  if (!server) {
    noteElicitationUnavailable("no server bound to this request context");
    return null;
  }

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          [fieldName]: {
            type: "string" as const,
            title: fieldName,
            description: `Select a ${fieldName}`,
            enum: options.map((o) => o.value),
            enumNames: options.map((o) => o.label),
          },
        },
        required: [fieldName],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content[fieldName] as string;
    }
    return null;
  } catch (err) {
    noteElicitationUnavailable(err);
    return null;
  }
}

/**
 * Ask the user for a free-text input.
 */
export async function elicitText(
  message: string,
  fieldName: string,
  description?: string
): Promise<string | null> {
  const server = getServerRef();
  if (!server) {
    noteElicitationUnavailable("no server bound to this request context");
    return null;
  }

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          [fieldName]: {
            type: "string" as const,
            title: fieldName,
            description: description ?? `Enter ${fieldName}`,
          },
        },
        required: [fieldName],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content[fieldName] as string;
    }
    return null;
  } catch (err) {
    noteElicitationUnavailable(err);
    return null;
  }
}

/**
 * Ask the user to confirm an action.
 */
export async function elicitConfirmation(
  message: string
): Promise<boolean | null> {
  const server = getServerRef();
  if (!server) {
    noteElicitationUnavailable("no server bound to this request context");
    return null;
  }

  try {
    const result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object" as const,
        properties: {
          confirm: {
            type: "boolean" as const,
            title: "Confirm",
            description: "Confirm this action",
          },
        },
        required: ["confirm"],
      },
    });

    if (result.action === "accept" && result.content) {
      return result.content.confirm as boolean;
    }
    return null;
  } catch (err) {
    noteElicitationUnavailable(err);
    return null;
  }
}
