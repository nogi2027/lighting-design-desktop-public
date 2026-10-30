export const CUE_NUMBER_PREFIX = "LX ";

export const FIELD_LIMITS = {
  cueNumber: 40,
  cueTitle: 300,
  cueDescription: 20_000,
  technicalNotes: 20_000,
  profileName: 120,
  profileRole: 120,
  profileInitials: 3,
  note: 20_000,
  reply: 20_000,
} as const;

export const CUE_NUMBER_SUFFIX_LIMIT = FIELD_LIMITS.cueNumber - CUE_NUMBER_PREFIX.length;

export function exceedsLimit(value: string, limit: number) {
  return value.length > limit;
}
