import PlainAxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * axe-Builder für die E2E-Specs (TD-16): bewegt vor jeder Analyse den Mauszeiger aus dem Inhalt. Nach einem Klick steht
 * der Zeiger sonst noch über dem Knopf, und axe misst dessen Hover-Zustand – das Ergebnis hing vom Ablauf ab (im
 * PR-Lauf grün, auf main rot). Wer den Hover-Zustand absichtlich prüfen will, ruft `.keepPointer()` auf.
 */
export class AxeBuilder extends PlainAxeBuilder {
  private readonly pageRef: Page;
  private keep = false;

  constructor(params: ConstructorParameters<typeof PlainAxeBuilder>[0]) {
    super(params);
    this.pageRef = params.page as unknown as Page;
  }

  /** Mauszeiger an Ort und Stelle lassen (Hover-Prüfung). */
  keepPointer(): this {
    this.keep = true;
    return this;
  }

  override async analyze() {
    if (!this.keep) {
      await this.pageRef.mouse.move(0, 0);
      // Übergänge (`transition`) des Hover-Zustands ausklingen lassen, bevor axe Farben liest
      await this.pageRef.waitForTimeout(250);
    }
    return super.analyze();
  }
}

export default AxeBuilder;
