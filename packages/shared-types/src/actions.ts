/**
 * Allowed Agent Actions whitelist.
 * Absolutely NO arbitrary script execution, eval, or raw code injection.
 */
export type ActionType = 'CLICK' | 'SCROLL' | 'WAIT' | 'NAVIGATE';

/**
 * Click action definition.
 * Can target a known elementId or bounded viewport coordinates.
 */
export interface ClickAction {
  action: 'CLICK';
  targetId?: string;
  targetCoordinates?: {
    x: number;
    y: number;
  };
  isDestructive?: boolean;
  confirmedByUser?: boolean;
}

/**
 * Scroll action definition with bounded distance.
 */
export interface ScrollAction {
  action: 'SCROLL';
  direction: 'up' | 'down' | 'left' | 'right';
  distance?: number; // clamped to [1, 2000]
}

/**
 * Wait action definition with bounded duration.
 */
export interface WaitAction {
  action: 'WAIT';
  durationMs: number; // clamped to [100, 10000]
}

/**
 * Navigate action definition with strict scheme validation.
 */
export interface NavigateAction {
  action: 'NAVIGATE';
  url: string;
}

/**
 * Union of all allowed agent actions.
 */
export type AgentAction = ClickAction | ScrollAction | WaitAction | NavigateAction;

/**
 * Validation outcome for an agent action.
 */
export interface ActionValidationResult {
  valid: boolean;
  decision: 'APPROVED' | 'BLOCKED' | 'REJECTED' | 'REQUIRES_CONFIRMATION';
  action: AgentAction | Record<string, unknown>;
  reasons: string[];
}

/**
 * Result of executing an approved agent action.
 */
export interface ActionExecutionResult {
  success: boolean;
  action: AgentAction;
  message: string;
  executedAt: number;
}
