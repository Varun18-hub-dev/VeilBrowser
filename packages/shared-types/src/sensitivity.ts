/**
 * Sensitivity classification types for VeilBrowse.
 *
 * These types describe the CATEGORY of data an element holds.
 * They never carry the actual data value.
 */

export enum SensitiveElementType {
  /** Credential/secret input field */
  PASSWORD = 'password',
  /** Field containing an email address */
  EMAIL = 'email',
  /** Field containing a phone or mobile number */
  PHONE = 'phone',
  /** Field containing a mailing or physical address */
  ADDRESS = 'address',
  /** Field containing government/national identity or customer account numbers */
  IDENTITY = 'identity',
  /** Field containing payment information (credit/debit card, CVV, exp date, banking) */
  PAYMENT = 'payment',
  /** Ambiguous or unconfirmed borderline sensitive field — fail-closed policy applies */
  UNKNOWN = 'unknown',
  /** Element is high-confidence safe / non-sensitive */
  NONE = 'none',
}

/**
 * Evidence signals that contributed to the classification decision.
 * Preserved for auditability — lets downstream consumers understand
 * why an element was marked sensitive.
 */
export type SensitivitySource =
  | 'type-attr'        // input[type] attribute
  | 'autocomplete'     // autocomplete attribute
  | 'name-attr'        // name attribute keyword match
  | 'id-attr'          // id attribute keyword match
  | 'aria-label'       // aria-label attribute keyword match
  | 'placeholder'      // placeholder attribute keyword match
  | 'label-text'       // associated <label> element text content
  | 'title-attr'       // title attribute keyword match
  | 'context-heading'  // nearby section heading or legend
  | 'pattern';         // structural format pattern matching on metadata

export interface SensitivityClassification {
  /** Whether this element is considered sensitive (fail-closed: true for UNKNOWN) */
  isSensitive: boolean;
  /** The specific category of sensitivity */
  type: SensitiveElementType;
  /**
   * Confidence score 0.0–1.0.
   * Reflects combined evidence strength.
   * 1.0 = definitive (e.g., type="password")
   * 0.45–0.69 = ambiguous / unconfirmed (treated as UNKNOWN)
   */
  confidence: number;
  /** All evidence sources that contributed to this classification */
  sources: SensitivitySource[];
  /** Human-readable explainability log (e.g., ["type=password", "context-heading contains 'Payment'"]) */
  reasons: string[];
}
