import Stripe from "stripe";

/**
 * Everything Bagger asks of the payment processor. Bagger works out what each
 * organization owes (server/billing/service.ts); Stripe keeps the card and
 * collects the money, sends receipts, and hosts each invoice as a page and a
 * PDF. Tests and the local preview use FakeGateway instead.
 */

export interface Card {
  brand: string;
  last4: string;
  /** "08/2028" */
  expires: string;
}

export interface ChargeLine {
  description: string;
  amountCents: number;
}

export interface ChargeResult {
  stripeInvoiceId: string;
  status: "paid" | "failed";
  hostedUrl: string | null;
  pdfUrl: string | null;
  failureMessage: string | null;
}

/** A Stripe event Bagger acts on, already checked to come from Stripe. */
export type BillingEvent =
  | { kind: "invoice"; stripeInvoiceId: string; status: "paid" | "failed"; message: string | null }
  | { kind: "ignored" };

export interface BillingGateway {
  ensureCustomer(org: {
    id: string;
    name: string;
    email: string;
    customerId: string | null;
  }): Promise<string>;
  /** A page where the owner enters a card; it sends them back to `returnUrl`. */
  cardSetupUrl(customerId: string, returnUrl: string, cancelUrl: string): Promise<string>;
  /** The card entered on that page, now the one charged. Null if it wasn't finished. */
  completeCardSetup(customerId: string, sessionId: string): Promise<Card | null>;
  /** Bill and charge once; the same key never charges twice. */
  charge(
    customerId: string,
    bill: {
      key: string;
      description: string;
      lines: ChargeLine[];
      metadata: Record<string, string>;
    },
  ): Promise<ChargeResult>;
  /** Try an unpaid invoice again, with the customer's current card. */
  retry(stripeInvoiceId: string): Promise<ChargeResult>;
  /** Check a webhook's signature and read it. Throws when the signature is wrong. */
  readEvent(rawBody: Buffer, signature: string): BillingEvent;
}

// ------------------------------------------------------------- Stripe

export class StripeGateway implements BillingGateway {
  private stripe: Stripe;

  constructor(
    secretKey: string,
    private webhookSecret: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async ensureCustomer(org: {
    id: string;
    name: string;
    email: string;
    customerId: string | null;
  }) {
    if (org.customerId) return org.customerId;
    const customer = await this.stripe.customers.create(
      { name: org.name, email: org.email, metadata: { orgId: org.id } },
      { idempotencyKey: `customer-${org.id}` },
    );
    return customer.id;
  }

  async cardSetupUrl(customerId: string, returnUrl: string, cancelUrl: string) {
    const session = await this.stripe.checkout.sessions.create({
      mode: "setup",
      customer: customerId,
      allowed_payment_method_types: ["card"],
      currency: "usd",
      success_url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a page for entering the card");
    return session.url;
  }

  async completeCardSetup(customerId: string, sessionId: string): Promise<Card | null> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["setup_intent.payment_method"],
    });
    const owner = typeof session.customer === "string" ? session.customer : session.customer?.id;
    if (owner !== customerId || session.status !== "complete") return null;
    const intent = session.setup_intent;
    const method =
      intent &&
      typeof intent !== "string" &&
      intent.payment_method &&
      typeof intent.payment_method !== "string"
        ? intent.payment_method
        : null;
    if (!method?.card) return null;
    await this.stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: method.id },
    });
    return {
      brand: method.card.brand,
      last4: method.card.last4,
      expires: `${String(method.card.exp_month).padStart(2, "0")}/${method.card.exp_year}`,
    };
  }

  private result(invoice: Stripe.Invoice, failureMessage: string | null = null): ChargeResult {
    return {
      stripeInvoiceId: invoice.id ?? "",
      status: invoice.status === "paid" ? "paid" : "failed",
      hostedUrl: invoice.hosted_invoice_url ?? null,
      pdfUrl: invoice.invoice_pdf ?? null,
      failureMessage: invoice.status === "paid" ? null : failureMessage,
    };
  }

  private async pay(invoiceId: string): Promise<ChargeResult> {
    try {
      return this.result(await this.stripe.invoices.pay(invoiceId));
    } catch (e) {
      const message = e instanceof Error ? e.message : "The card was declined";
      return this.result(await this.stripe.invoices.retrieve(invoiceId), message);
    }
  }

  async charge(
    customerId: string,
    bill: {
      key: string;
      description: string;
      lines: ChargeLine[];
      metadata: Record<string, string>;
    },
  ) {
    const draft = await this.stripe.invoices.create(
      {
        customer: customerId,
        collection_method: "charge_automatically",
        auto_advance: false,
        pending_invoice_items_behavior: "exclude",
        description: bill.description,
        metadata: bill.metadata,
      },
      { idempotencyKey: `invoice-${bill.key}` },
    );
    const id = draft.id ?? "";
    if (draft.status === "draft") {
      for (const [i, line] of bill.lines.entries()) {
        await this.stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: id,
            amount: line.amountCents,
            currency: "usd",
            description: line.description,
          },
          { idempotencyKey: `item-${bill.key}-${i}` },
        );
      }
      await this.stripe.invoices.finalizeInvoice(id);
    }
    return this.pay(id);
  }

  async retry(stripeInvoiceId: string) {
    return this.pay(stripeInvoiceId);
  }

  readEvent(rawBody: Buffer, signature: string): BillingEvent {
    if (!this.webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is not set");
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      return {
        kind: "invoice",
        stripeInvoiceId: invoice.id ?? "",
        status: event.type === "invoice.paid" ? "paid" : "failed",
        message: event.type === "invoice.paid" ? null : "The card was declined",
      };
    }
    return { kind: "ignored" };
  }
}

// --------------------------------------------------------------- fake

/** Stands in for Stripe in tests and the local preview. Nothing leaves the machine. */
export class FakeGateway implements BillingGateway {
  customers = 0;
  sessions = new Map<string, string>();
  invoices = new Map<
    string,
    { customerId: string; amountCents: number; status: "paid" | "failed" }
  >();
  byKey = new Map<string, string>();
  /** Set to make the next charges fail, as a declined card would. */
  decline = false;

  async ensureCustomer(org: { customerId: string | null }) {
    return org.customerId ?? `cus_fake_${++this.customers}`;
  }

  async cardSetupUrl(customerId: string, returnUrl: string) {
    const id = `cs_fake_${this.sessions.size + 1}`;
    this.sessions.set(id, customerId);
    return `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}session_id=${id}`;
  }

  async completeCardSetup(customerId: string, sessionId: string) {
    if (this.sessions.get(sessionId) !== customerId) return null;
    return { brand: "visa", last4: "4242", expires: "12/2030" };
  }

  private settle(id: string): ChargeResult {
    const invoice = this.invoices.get(id)!;
    invoice.status = this.decline ? "failed" : "paid";
    return {
      stripeInvoiceId: id,
      status: invoice.status,
      hostedUrl: `https://invoice.stripe.example/${id}`,
      pdfUrl: `https://invoice.stripe.example/${id}.pdf`,
      failureMessage: this.decline ? "Your card was declined." : null,
    };
  }

  async charge(customerId: string, bill: { key: string; lines: ChargeLine[] }) {
    let id = this.byKey.get(bill.key);
    if (!id) {
      id = `in_fake_${this.invoices.size + 1}`;
      this.byKey.set(bill.key, id);
      const amountCents = bill.lines.reduce((sum, l) => sum + l.amountCents, 0);
      this.invoices.set(id, { customerId, amountCents, status: "failed" });
    }
    return this.settle(id);
  }

  async retry(stripeInvoiceId: string) {
    return this.settle(stripeInvoiceId);
  }

  readEvent(rawBody: Buffer, signature: string): BillingEvent {
    if (signature !== "fake-signature") throw new Error("bad signature");
    const event = JSON.parse(rawBody.toString()) as { type: string; id: string };
    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      return {
        kind: "invoice",
        stripeInvoiceId: event.id,
        status: event.type === "invoice.paid" ? "paid" : "failed",
        message: event.type === "invoice.paid" ? null : "Your card was declined.",
      };
    }
    return { kind: "ignored" };
  }
}
