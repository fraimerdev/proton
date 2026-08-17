export const ServerLogColors = {
  Add: 0x57_f2_87,
  Modify: 0xfe_e7_5c,
  Remove: 0xed_42_45,
} as const;

export type ServerLogColor = (typeof ServerLogColors)[keyof typeof ServerLogColors];
