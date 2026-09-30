export interface TermResponse {
  termId: string;
  code: string;
  version: string;
  required: boolean;
  documentUrl: string;
  effectiveAt: string;
}

export interface TermsResponse {
  terms: TermResponse[];
}
