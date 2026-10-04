// Confidence of a person's score on one axis in one sector (spec 5.1).

export interface ConfidenceInputs {
  verified: number; // V
  claimed: number; // C
  distinctEvidenceTypes: number; // among counted verified evidence
  distinctVerifiers: number; // among counted verified evidence
}

export function verifiedShare(verified: number, claimed: number): number {
  const total = verified + claimed;
  return total <= 0 ? 0 : verified / total;
}

export function breadth(distinctEvidenceTypes: number, distinctVerifiers: number): number {
  return 0.5 * Math.min(1, distinctEvidenceTypes / 3) + 0.5 * Math.min(1, distinctVerifiers / 2);
}

/** confidence = verified_share * breadth, in [0,1]. */
export function confidence(i: ConfidenceInputs): number {
  return verifiedShare(i.verified, i.claimed) * breadth(i.distinctEvidenceTypes, i.distinctVerifiers);
}
