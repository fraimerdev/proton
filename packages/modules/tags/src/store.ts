export interface Tag {
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
  updatedBy: string | null;
  uses: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTagInput {
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
}

export interface ListTagsQuery {
  guildId: string;
  page: number;
  pageSize: number;
}

export interface ListTagsResult {
  tags: Tag[];
  total: number;
}

export interface TagStore {
  get(guildId: string, name: string): Promise<Tag | null>;

  // One statement, not read-then-write: two members recalling the same tag at once must both be
  // counted, and a read-modify-write in application code loses one of them.
  recall(guildId: string, name: string): Promise<Tag | null>;

  create(input: CreateTagInput): Promise<'created' | 'exists'>;
  update(guildId: string, name: string, content: string, editedBy: string): Promise<boolean>;
  remove(guildId: string, name: string): Promise<boolean>;

  list(query: ListTagsQuery): Promise<ListTagsResult>;
  count(guildId: string): Promise<number>;

  suggest(guildId: string, prefix: string, limit: number): Promise<string[]>;
}
