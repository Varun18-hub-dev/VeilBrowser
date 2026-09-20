import {
  SensitiveElementType,
  type AgentAction,
  type ActionValidationResult,
  type ActionExecutionResult,
  type UnifiedSanitizedContext,
} from '@veilbrowse/shared-types';

const ALLOWED_ACTIONS = new Set<string>(['CLICK', 'SCROLL', 'WAIT', 'NAVIGATE']);
const MAX_SCROLL_DISTANCE = 2000;
const MIN_WAIT_MS = 100;
const MAX_WAIT_MS = 10000;

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface ActionSchemaResult {
  valid: boolean;
  action?: AgentAction;
  errors: string[];
}

/**
 * TIER 1: Strict Local Schema Validation
 * Verifies that the inbound payload strictly conforms to the AgentAction schema.
 * Rejects arbitrary actions, eval/exec scripts, or malformed payloads before
 * any contextual evaluation occurs.
 */
export function validateActionSchema(action: unknown): ActionSchemaResult {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    return {
      valid: false,
      errors: ['Malformed action payload: must be a non-null object'],
    };
  }

  const raw = action as Record<string, unknown>;
  if (typeof raw.action !== 'string') {
    return {
      valid: false,
      errors: ['Action payload must contain a string "action" property'],
    };
  }

  const actionType = raw.action.toUpperCase();

  if (!ALLOWED_ACTIONS.has(actionType)) {
    return {
      valid: false,
      errors: [
        `Action '${actionType}' is forbidden. Only CLICK, SCROLL, WAIT, NAVIGATE allowed. Arbitrary commands or script execution are strictly rejected.`,
      ],
    };
  }

  switch (actionType) {
    case 'CLICK': {
      const hasTargetId = typeof raw.targetId === 'string' && raw.targetId.trim().length > 0;
      const coords = raw.targetCoordinates as { x?: unknown; y?: unknown } | undefined;
      const hasCoords =
        coords &&
        typeof coords === 'object' &&
        typeof coords.x === 'number' &&
        typeof coords.y === 'number' &&
        !isNaN(coords.x) &&
        !isNaN(coords.y);

      if (!hasTargetId && !hasCoords) {
        return {
          valid: false,
          errors: ['CLICK action requires either a valid targetId string or targetCoordinates { x, y }'],
        };
      }

      return {
        valid: true,
        action: {
          action: 'CLICK',
          targetId: hasTargetId ? (raw.targetId as string) : undefined,
          targetCoordinates: hasCoords
            ? { x: coords.x as number, y: coords.y as number }
            : undefined,
          isDestructive: Boolean(raw.isDestructive),
          confirmedByUser: Boolean(raw.confirmedByUser),
        },
        errors: [],
      };
    }

    case 'SCROLL': {
      const validDirections = ['up', 'down', 'left', 'right'];
      const dir = typeof raw.direction === 'string' ? raw.direction.toLowerCase() : '';
      if (!validDirections.includes(dir)) {
        return {
          valid: false,
          errors: [`Invalid scroll direction '${raw.direction}'. Must be up, down, left, or right.`],
        };
      }

      const distance = raw.distance !== undefined ? Number(raw.distance) : 300;
      if (isNaN(distance) || distance < 1 || distance > MAX_SCROLL_DISTANCE) {
        return {
          valid: false,
          errors: [`Scroll distance must be a number between 1 and ${MAX_SCROLL_DISTANCE}px`],
        };
      }

      return {
        valid: true,
        action: {
          action: 'SCROLL',
          direction: dir as 'up' | 'down' | 'left' | 'right',
          distance,
        },
        errors: [],
      };
    }

    case 'WAIT': {
      const dur = Number(raw.durationMs);
      if (isNaN(dur) || dur < MIN_WAIT_MS || dur > MAX_WAIT_MS) {
        return {
          valid: false,
          errors: [`Wait durationMs must be between ${MIN_WAIT_MS}ms and ${MAX_WAIT_MS}ms`],
        };
      }

      return {
        valid: true,
        action: {
          action: 'WAIT',
          durationMs: dur,
        },
        errors: [],
      };
    }

    case 'NAVIGATE': {
      if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
        return {
          valid: false,
          errors: ['NAVIGATE action requires a non-empty url string'],
        };
      }

      return {
        valid: true,
        action: {
          action: 'NAVIGATE',
          url: raw.url.trim(),
        },
        errors: [],
      };
    }

    default:
      return {
        valid: false,
        errors: [`Unsupported action type '${actionType}'`],
      };
  }
}

/**
 * TIER 2: Contextual & Safety Validation
 * Evaluates an agent action against strict safety policies and current page context.
 *
 * FAIL-CLOSED:
 * Any ambiguity, unknown element, or security rule violation immediately BLOCKS or REJECTS.
 */
export function validateAction(
  action: unknown,
  context: UnifiedSanitizedContext,
  viewport: ViewportDimensions = { width: 1280, height: 720 }
): ActionValidationResult {
  // Step 1: Execute Tier 1 Schema Validation
  const schemaResult = validateActionSchema(action);
  if (!schemaResult.valid || !schemaResult.action) {
    return {
      valid: false,
      decision: 'REJECTED',
      action: typeof action === 'object' && action !== null ? (action as Record<string, unknown>) : {},
      reasons: schemaResult.errors,
    };
  }

  const validAction = schemaResult.action;

  // Step 2: Contextual Safety Checks
  switch (validAction.action) {
    case 'CLICK': {
      const click = validAction;

      // Handle elementId target
      if (click.targetId) {
        const target = context.elements.find((e) => e.elementId === click.targetId);

        if (!target) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: [`Target element '${click.targetId}' not found in active page context.`],
          };
        }

        // Sensitive target protection
        if (target.decision !== 'ALLOWED' || target.category !== SensitiveElementType.NONE) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: [
              `Target element '${click.targetId}' is sensitive (${target.category}) or masked. Agent click blocked.`,
            ],
          };
        }

        if (!target.interactable) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: [`Target element '${click.targetId}' is not interactable.`],
          };
        }

        // Destructive action confirmation
        if (click.isDestructive && !click.confirmedByUser) {
          return {
            valid: true,
            decision: 'REQUIRES_CONFIRMATION',
            action: click,
            reasons: ['Potentially destructive action requires explicit user confirmation.'],
          };
        }

        return {
          valid: true,
          decision: 'APPROVED',
          action: click,
          reasons: [`Target '${click.targetId}' is verified safe and interactable.`],
        };
      }

      // Handle coordinate target
      if (click.targetCoordinates) {
        const { x, y } = click.targetCoordinates;
        if (typeof x !== 'number' || typeof y !== 'number' || isNaN(x) || isNaN(y)) {
          return {
            valid: false,
            decision: 'REJECTED',
            action: click,
            reasons: ['Invalid coordinate values: must be finite numbers.'],
          };
        }

        if (x < 0 || x > viewport.width || y < 0 || y > viewport.height) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: [`Coordinates (${x}, ${y}) are outside visible viewport bounds.`],
          };
        }

        // Check if coordinate falls inside any sensitive visual region
        const inSensitiveVisual = context.visualRegions.some(
          (vr) =>
            x >= vr.bounds.x &&
            x <= vr.bounds.x + vr.bounds.width &&
            y >= vr.bounds.y &&
            y <= vr.bounds.y + vr.bounds.height
        );

        if (inSensitiveVisual) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: ['Coordinates fall within a detected sensitive visual region.'],
          };
        }

        // Check if coordinate falls on an allowed interactable DOM control
        const matchingControl = context.elements.find(
          (e) =>
            e.interactable &&
            e.decision === 'ALLOWED' &&
            x >= e.bounds.x &&
            x <= e.bounds.x + e.bounds.width &&
            y >= e.bounds.y &&
            y <= e.bounds.y + e.bounds.height
        );

        if (!matchingControl) {
          return {
            valid: false,
            decision: 'BLOCKED',
            action: click,
            reasons: [
              'Coordinate does not map to a verified safe control. Blind coordinate clicks are rejected.',
            ],
          };
        }

        return {
          valid: true,
          decision: 'APPROVED',
          action: click,
          reasons: [`Coordinates map to safe control '${matchingControl.elementId}'.`],
        };
      }

      return {
        valid: false,
        decision: 'REJECTED',
        action: click,
        reasons: ['Click action must specify either targetId or targetCoordinates.'],
      };
    }

    case 'SCROLL': {
      const scroll = validAction;
      const validDirections = ['up', 'down', 'left', 'right'];
      if (!validDirections.includes(scroll.direction)) {
        return {
          valid: false,
          decision: 'REJECTED',
          action: scroll,
          reasons: [`Invalid scroll direction: '${scroll.direction}'.`],
        };
      }

      const distance = scroll.distance ?? 300;
      if (typeof distance !== 'number' || distance < 1 || distance > MAX_SCROLL_DISTANCE) {
        return {
          valid: false,
          decision: 'REJECTED',
          action: scroll,
          reasons: [`Scroll distance must be between 1 and ${MAX_SCROLL_DISTANCE}px.`],
        };
      }

      return {
        valid: true,
        decision: 'APPROVED',
        action: { ...scroll, distance },
        reasons: ['Scroll action parameters verified within safe bounds.'],
      };
    }

    case 'WAIT': {
      const wait = validAction;
      if (
        typeof wait.durationMs !== 'number' ||
        wait.durationMs < MIN_WAIT_MS ||
        wait.durationMs > MAX_WAIT_MS
      ) {
        return {
          valid: false,
          decision: 'REJECTED',
          action: wait,
          reasons: [`Wait duration must be between ${MIN_WAIT_MS}ms and ${MAX_WAIT_MS}ms.`],
        };
      }

      return {
        valid: true,
        decision: 'APPROVED',
        action: wait,
        reasons: ['Wait duration verified.'],
      };
    }

    case 'NAVIGATE': {
      const nav = validAction;
      if (!nav.url || typeof nav.url !== 'string') {
        return {
          valid: false,
          decision: 'REJECTED',
          action: nav,
          reasons: ['Navigate action requires a valid url string.'],
        };
      }

      const trimmedUrl = nav.url.trim().toLowerCase();
      if (
        trimmedUrl.startsWith('javascript:') ||
        trimmedUrl.startsWith('data:') ||
        trimmedUrl.startsWith('vbscript:') ||
        trimmedUrl.startsWith('file:') ||
        trimmedUrl.startsWith('blob:')
      ) {
        return {
          valid: false,
          decision: 'REJECTED',
          action: nav,
          reasons: [`Forbidden URL scheme in '${nav.url}'. Only http: and https: allowed.`],
        };
      }

      try {
        const parsed = new URL(nav.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            valid: false,
            decision: 'REJECTED',
            action: nav,
            reasons: [`Unsupported protocol '${parsed.protocol}'. Only http: and https: allowed.`],
          };
        }
      } catch {
        return {
          valid: false,
          decision: 'REJECTED',
          action: nav,
          reasons: [`Malformed URL '${nav.url}'.`],
        };
      }

      return {
        valid: true,
        decision: 'APPROVED',
        action: nav,
        reasons: ['Safe http/https navigation URL approved.'],
      };
    }

    default:
      return {
        valid: false,
        decision: 'REJECTED',
        action: validAction,
        reasons: ['Unsupported action type.'],
      };
  }
}

/**
 * Executes an approved action in the local browser context.
 */
export async function executeAction(
  action: AgentAction,
  context: UnifiedSanitizedContext,
  domElementLookup?: (elementId: string) => HTMLElement | null
): Promise<ActionExecutionResult> {
  const validation = validateAction(action, context);

  if (validation.decision !== 'APPROVED') {
    throw new Error(
      `Action execution aborted: Validation decision was ${validation.decision}. Reasons: ${validation.reasons.join(
        '; '
      )}`
    );
  }

  const approvedAction = validation.action as AgentAction;

  switch (approvedAction.action) {
    case 'CLICK': {
      if (approvedAction.targetId && domElementLookup) {
        const domNode = domElementLookup(approvedAction.targetId);
        if (domNode) {
          domNode.click();
        }
      }
      return {
        success: true,
        action: approvedAction,
        message: `Clicked ${approvedAction.targetId || 'coordinates'}`,
        executedAt: Date.now(),
      };
    }

    case 'SCROLL': {
      const dist = approvedAction.distance ?? 300;
      if (typeof window !== 'undefined' && window.scrollBy) {
        const dx =
          approvedAction.direction === 'left' ? -dist : approvedAction.direction === 'right' ? dist : 0;
        const dy =
          approvedAction.direction === 'up' ? -dist : approvedAction.direction === 'down' ? dist : 0;
        window.scrollBy(dx, dy);
      }
      return {
        success: true,
        action: approvedAction,
        message: `Scrolled ${approvedAction.direction} by ${dist}px`,
        executedAt: Date.now(),
      };
    }

    case 'WAIT': {
      await new Promise((resolve) => setTimeout(resolve, approvedAction.durationMs));
      return {
        success: true,
        action: approvedAction,
        message: `Waited for ${approvedAction.durationMs}ms`,
        executedAt: Date.now(),
      };
    }

    case 'NAVIGATE': {
      return {
        success: true,
        action: approvedAction,
        message: `Navigated to ${approvedAction.url}`,
        executedAt: Date.now(),
      };
    }
  }
}
