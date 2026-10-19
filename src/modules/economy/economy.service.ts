import { AppError } from "../../shared/errors/app-error.js";
import { ErrorCode } from "../../shared/errors/error-codes.js";
import type { Clock } from "../../shared/kernel/clock.js";
import type { WalletSnapshot } from "../../shared/kernel/types.js";
import type { DbSession, UnitOfWork } from "../../shared/kernel/unit-of-work.js";
import { applyRecharge } from "./economy.domain.js";
import type { CurrencyRules, WalletRepository, WalletRow } from "./economy.ports.js";
import type { WalletLedger } from "./wallet-ledger.js";

/** Economy use cases exposed to players (wallet read, generic spend, fusion). */
export class EconomyService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly ledger: WalletLedger,
    private readonly currencies: CurrencyRules,
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /** Creates wallet rows for every catalog currency the user doesn't have yet (initial amounts). */
  async ensureUserCurrencies(userId: string, session?: DbSession): Promise<void> {
    const catalog = this.currencies.list();
    if (catalog.length === 0) return;

    const have = new Set((await this.wallets.listWallet(userId, session)).map((row) => row.currencyId));
    const missing: WalletRow[] = catalog
      .filter((currency) => !have.has(currency.id))
      .map((currency) => ({
        currencyId: currency.id,
        amount: Math.max(0, Math.floor(Number(currency.initialAmount) || 0)),
        lastTickAt: null as Date | null,
      }));

    if (missing.length > 0) {
      await this.wallets.insertMissing(userId, missing, session);
    }
  }

  /** Full wallet with pending offline recharge applied and persisted (inside `session` when the caller has one). */
  async getWallet(userId: string, session?: DbSession): Promise<WalletRow[]> {
    if (session) return this.walletIn(userId, session);
    return this.uow.transaction((own) => this.walletIn(userId, own));
  }

  private async walletIn(userId: string, session: DbSession): Promise<WalletRow[]> {
    const wallet = await this.wallets.listWallet(userId, session);
    const rechargeable = wallet.filter((row) => {
      const cfg = this.currencies.get(row.currencyId);
      return !!cfg?.rechargeable && !!cfg.rechargeOffline;
    });
    if (rechargeable.length === 0) return wallet;

    const locked = await this.wallets.lockRows(userId, rechargeable.map((row) => row.currencyId), session);
    const level = await this.wallets.getAccountLevel(userId, session);
    const nowMs = this.clock.nowMs();

    for (const row of locked.values()) {
      const cfg = this.currencies.get(row.currencyId);
      if (cfg && applyRecharge(row, cfg, level, nowMs)) {
        await this.wallets.saveRow(userId, row, session);
      }
    }

    return wallet.map((row) => locked.get(row.currencyId) ?? row);
  }

  /** Wallet keyed by currency id (no recharge). */
  async getWalletSnapshot(userId: string): Promise<WalletSnapshot> {
    return this.ledger.snapshot(userId);
  }

  /** Generic player-initiated spend (the player can only lose currency). Returns the new balance. */
  async spend(userId: string, currencyId: string, amount: number): Promise<number> {
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError(ErrorCode.ECON_INVALID_AMOUNT);
    if (!this.currencies.get(currencyId)) throw new AppError(ErrorCode.ECON_CURRENCY_NOT_FOUND);

    const balances = await this.uow.transaction((session) =>
      this.ledger.debit(session, userId, [{ currencyId, amount }]),
    );
    return balances[currencyId];
  }

  /** Converts `quantity` units of a fusable currency into its target currency. */
  async fuse(userId: string, inputCurrencyId: string, quantity: number): Promise<WalletSnapshot> {
    if (!inputCurrencyId || !Number.isInteger(quantity) || quantity <= 0) throw new AppError(ErrorCode.ECON_INVALID_AMOUNT);

    const input = this.currencies.get(inputCurrencyId);
    if (!input?.canFuse || !input.fusionTargetCurrencyId) throw new AppError(ErrorCode.ECON_FUSION_NOT_AVAILABLE);

    const outputCurrencyId = String(input.fusionTargetCurrencyId);
    if (!this.currencies.get(outputCurrencyId)) throw new AppError(ErrorCode.ECON_CURRENCY_NOT_FOUND);

    const extraCurrencyId = input.fusionExtraCostCurrencyId ? String(input.fusionExtraCostCurrencyId) : null;
    if (extraCurrencyId && !this.currencies.get(extraCurrencyId)) throw new AppError(ErrorCode.ECON_CURRENCY_NOT_FOUND);

    const totalInput = Math.max(1, Number(input.fusionRequiredAmount || 1)) * quantity;
    const totalExtra = extraCurrencyId ? Math.max(0, Number(input.fusionExtraCostAmount || 0)) * quantity : 0;

    return this.uow.transaction(async (session) => {
      const spentInput = await this.ledger.debit(session, userId, [{ currencyId: inputCurrencyId, amount: totalInput }], {
        insufficientError: ErrorCode.ECON_INSUFFICIENT_INPUT,
      });
      const spentExtra = extraCurrencyId && totalExtra > 0
        ? await this.ledger.debit(session, userId, [{ currencyId: extraCurrencyId, amount: totalExtra }], {
            insufficientError: ErrorCode.ECON_INSUFFICIENT_COST,
          })
        : {};
      const credited = await this.ledger.credit(session, userId, [{ currencyId: outputCurrencyId, amount: quantity }]);

      return { ...spentInput, ...spentExtra, ...credited };
    });
  }
}
