// Currency for asynchronous Preferences reads. Cache operations are serialized
// by the backend; this token separately decides whether their answers still
// describe the dialog and project currently on screen.

export interface PreferenceRequest {
  serial: number;
  root: string | null;
}

export class PreferenceRequests {
  private serial = 0;
  private visible = false;

  open(root: string | null): PreferenceRequest {
    this.visible = true;
    return this.begin(root);
  }

  refresh(root: string | null): PreferenceRequest | null {
    if (!this.visible) return null;
    return this.begin(root);
  }

  beginWork(root: string | null): PreferenceRequest | null {
    if (!this.visible) return null;
    return this.begin(root);
  }

  close(): void {
    this.visible = false;
    this.serial += 1;
  }

  isOpen(): boolean {
    return this.visible;
  }

  isCurrent(request: PreferenceRequest, root: string | null): boolean {
    return this.visible && request.serial === this.serial && request.root === root;
  }

  private begin(root: string | null): PreferenceRequest {
    this.serial += 1;
    return { serial: this.serial, root };
  }
}
