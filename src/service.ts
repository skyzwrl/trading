import { HttpService } from "@rbxts/services";
import { Offer, Trade } from "./trade";
import { transferAll } from "./transfer";
import {
	RequestCloseReason,
	TradeEndReason,
	TradeError,
	TradeEvent,
	TradeInventory,
	TradeOptions,
	TradeRecord,
	TradeRequest,
	TradeResult,
	TradeView,
	Transfer,
} from "./types";

const OK: TradeResult = { ok: true };

function fail(reason: TradeError): TradeResult {
	return { ok: false, reason };
}

function seconds(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!(result >= 0 && result < math.huge)) {
		throw `${name} must be a finite number of seconds >= 0, got ${result}`;
	}
	return result;
}

function count(value: number | undefined, fallback: number, name: string): number {
	const result = value ?? fallback;
	if (!(result >= 1 && result < math.huge) || result % 1 !== 0) {
		throw `${name} must be a whole number >= 1, got ${result}`;
	}
	return result;
}

export class TradeService<P extends defined> {
	private readonly inventory: TradeInventory<P>;
	private readonly requestTimeout: number;
	private readonly requestCooldown: number;
	private readonly maxOutgoing: number;
	private readonly maxIncoming: number;
	private readonly maxItems: number;
	private readonly countdown: number;
	private readonly readyDelay: number;
	private readonly logSize: number;
	private readonly valueOf?: (itemId: string, owner: P) => number;
	private readonly currencyValue: number;
	private readonly imbalanceRatio: number;
	private readonly clock: () => number;
	private readonly timestamp: () => number;
	private readonly generateId: () => string;

	private readonly outgoing = new Map<P, Map<P, TradeRequest<P>>>();
	private readonly incomingCounts = new Map<P, number>();
	private readonly lastRequestAt = new Map<P, number>();
	private readonly trades = new Map<P, Trade<P>>();
	private readonly active = new Set<Trade<P>>();
	private readonly locks = new Map<string, Trade<P>>();
	private readonly log = new Array<TradeRecord<P>>();
	private readonly listeners = new Array<(event: TradeEvent<P>) => void>();

	public constructor(options: TradeOptions<P>) {
		this.inventory = options.inventory;
		this.requestTimeout = seconds(options.requestTimeout, 30, "requestTimeout");
		this.requestCooldown = seconds(options.requestCooldown, 2, "requestCooldown");
		this.maxOutgoing = count(options.maxOutgoingRequests, 3, "maxOutgoingRequests");
		this.maxIncoming = count(options.maxIncomingRequests, 10, "maxIncomingRequests");
		this.maxItems = count(options.maxItems, 20, "maxItems");
		this.countdown = seconds(options.countdown, 5, "countdown");
		this.readyDelay = seconds(options.readyDelay, 2, "readyDelay");
		this.logSize = count(options.logSize, 100, "logSize");
		this.valueOf = options.valueOf;
		this.currencyValue = options.currencyValue ?? 1;
		this.imbalanceRatio = options.imbalanceRatio ?? 3;
		this.clock = options.clock ?? os.clock;
		this.timestamp = options.timestamp ?? os.time;
		this.generateId = options.generateId ?? (() => HttpService.GenerateGUID(false));
	}

	public onEvent(listener: (event: TradeEvent<P>) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.remove(index);
			}
		};
	}

	public request(from: P, to: P): TradeResult {
		if (from === to) {
			return fail("SelfTrade");
		}
		const now = this.clock();
		this.expireRequests(now);

		const last = this.lastRequestAt.get(from);
		if (last !== undefined && now - last < this.requestCooldown) {
			return fail("Cooldown");
		}
		const trade = this.trades.get(from);
		if (trade !== undefined && trade === this.trades.get(to)) {
			return fail("AlreadyTrading");
		}

		let sent = this.outgoing.get(from);
		if (sent?.has(to)) {
			return fail("AlreadyRequested");
		} else if (sent !== undefined && sent.size() >= this.maxOutgoing) {
			return fail("TooManyRequests");
		}
		const incoming = this.incomingCounts.get(to) ?? 0;
		if (incoming >= this.maxIncoming) {
			return fail("TargetBusy");
		}

		if (sent === undefined) {
			sent = new Map();
			this.outgoing.set(from, sent);
		}
		const request: TradeRequest<P> = { from, to, expiresAt: now + this.requestTimeout };
		sent.set(to, request);
		this.incomingCounts.set(to, incoming + 1);
		this.lastRequestAt.set(from, now);
		this.emit({ kind: "requested", request });
		return OK;
	}

	public accept(player: P, from: P): TradeResult {
		const now = this.clock();
		this.expireRequests(now);

		const request = this.outgoing.get(from)?.get(player);
		if (request === undefined) {
			return fail("NoRequest");
		}
		this.closeRequest(request, "Accepted");
		const reverse = this.outgoing.get(player)?.get(from);
		if (reverse !== undefined) {
			this.closeRequest(reverse, "Cancelled");
		}

		// accepting is how a player moves on, so whatever either of them was trading before ends here
		const previous = this.trades.get(from);
		if (previous !== undefined) {
			this.endTrade(previous, "StartedAnother");
		}
		const current = this.trades.get(player);
		if (current !== undefined) {
			this.endTrade(current, "StartedAnother");
		}

		const trade = new Trade(this.generateId(), [from, player], now);
		this.trades.set(from, trade);
		this.trades.set(player, trade);
		this.active.add(trade);
		this.emit({ kind: "started", trade: trade.view() });
		return OK;
	}

	public decline(player: P, from: P): TradeResult {
		const request = this.outgoing.get(from)?.get(player);
		if (request === undefined) {
			return fail("NoRequest");
		}
		this.closeRequest(request, "Declined");
		return OK;
	}

	public cancelRequest(player: P, to: P): TradeResult {
		const request = this.outgoing.get(player)?.get(to);
		if (request === undefined) {
			return fail("NoRequest");
		}
		this.closeRequest(request, "Cancelled");
		return OK;
	}

	public addItem(player: P, itemId: string): TradeResult {
		const trade = this.trades.get(player);
		if (trade === undefined) {
			return fail("NotTrading");
		}
		const offer = trade.offerOf(player);
		if (offer.items.includes(itemId)) {
			return fail("AlreadyOffered");
		} else if (offer.items.size() >= this.maxItems) {
			return fail("OfferFull");
		} else if (this.locks.has(itemId)) {
			return fail("ItemLocked");
		} else if (!this.inventory.hasItem(player, itemId)) {
			return fail("NotOwned");
		}

		offer.items.push(itemId);
		this.locks.set(itemId, trade);
		this.changed(trade);
		return OK;
	}

	public removeItem(player: P, itemId: string): TradeResult {
		const trade = this.trades.get(player);
		if (trade === undefined) {
			return fail("NotTrading");
		}
		const offer = trade.offerOf(player);
		const index = offer.items.indexOf(itemId);
		if (index === -1) {
			return fail("NotOffered");
		}

		offer.items.remove(index);
		this.locks.delete(itemId);
		this.changed(trade);
		return OK;
	}

	public setCurrency(player: P, amount: number): TradeResult {
		const trade = this.trades.get(player);
		if (trade === undefined) {
			return fail("NotTrading");
		}
		if (!(amount >= 0 && amount < math.huge) || amount % 1 !== 0) {
			return fail("InvalidAmount");
		} else if (amount > this.inventory.getCurrency(player)) {
			return fail("NotEnoughCurrency");
		}

		const offer = trade.offerOf(player);
		if (offer.currency !== amount) {
			offer.currency = amount;
			this.changed(trade);
		}
		return OK;
	}

	public setReady(player: P, ready: boolean, revision?: number): TradeResult {
		const trade = this.trades.get(player);
		if (trade === undefined) {
			return fail("NotTrading");
		} else if (revision !== undefined && revision !== trade.revision) {
			return fail("Stale");
		}

		const offer = trade.offerOf(player);
		if (offer.ready === ready) {
			return OK;
		}

		if (ready) {
			const now = this.clock();
			if (now - trade.lastChangeAt < this.readyDelay) {
				return fail("TooSoon");
			} else if (trade.isEmpty()) {
				return fail("EmptyTrade");
			}
			offer.ready = true;
			this.checkBalance(trade, player);
			const [first, second] = trade.offers;
			if (first.ready && second.ready) {
				trade.countdownEndsAt = now + this.countdown;
			}
		} else {
			offer.ready = false;
			trade.countdownEndsAt = undefined;
		}

		this.emit({ kind: "changed", trade: trade.view() });
		return OK;
	}

	public cancel(player: P): TradeResult {
		const trade = this.trades.get(player);
		if (trade === undefined) {
			return fail("NotTrading");
		}
		this.endTrade(trade, "Cancelled");
		return OK;
	}

	public playerLeft(player: P): void {
		const trade = this.trades.get(player);
		if (trade !== undefined) {
			this.endTrade(trade, "PlayerLeft");
		}

		const closing = new Array<TradeRequest<P>>();
		for (const [from, sent] of this.outgoing) {
			for (const [to, request] of sent) {
				if (from === player || to === player) {
					closing.push(request);
				}
			}
		}
		for (const request of closing) {
			this.closeRequest(request, "PlayerLeft");
		}
		this.lastRequestAt.delete(player);
	}

	// expires requests and finishes countdowns. bindTradeService runs it every Heartbeat
	public update(): void {
		const now = this.clock();
		this.expireRequests(now);

		const due = new Array<Trade<P>>();
		for (const trade of this.active) {
			if (trade.countdownEndsAt !== undefined && now >= trade.countdownEndsAt) {
				due.push(trade);
			}
		}
		for (const trade of due) {
			if (this.active.has(trade)) {
				this.complete(trade);
			}
		}
	}

	public getTrade(player: P): TradeView<P> | undefined {
		return this.trades.get(player)?.view();
	}

	public isTrading(player: P): boolean {
		return this.trades.has(player);
	}

	// ask this before selling, deleting, equipping or gifting an item
	public isLocked(itemId: string): boolean {
		return this.locks.has(itemId);
	}

	public getIncomingRequests(player: P): TradeRequest<P>[] {
		const requests = new Array<TradeRequest<P>>();
		for (const [, sent] of this.outgoing) {
			const request = sent.get(player);
			if (request !== undefined) {
				requests.push(request);
			}
		}
		return requests;
	}

	public getOutgoingRequests(player: P): TradeRequest<P>[] {
		const requests = new Array<TradeRequest<P>>();
		const sent = this.outgoing.get(player);
		if (sent !== undefined) {
			for (const [, request] of sent) {
				requests.push(request);
			}
		}
		return requests;
	}

	public getLog(): readonly TradeRecord<P>[] {
		return table.clone(this.log);
	}

	public findRecord(id: string): TradeRecord<P> | undefined {
		return this.log.find((record) => record.id === id);
	}

	private emit(event: TradeEvent<P>): void {
		if (this.listeners.isEmpty()) {
			return;
		}
		// spawned so a listener that yields (saving, firing remotes) or errors can't stall the trade
		for (const listener of table.clone(this.listeners)) {
			task.spawn(listener, event);
		}
	}

	private changed(trade: Trade<P>): void {
		trade.revision += 1;
		trade.lastChangeAt = this.clock();
		trade.unready();
		this.emit({ kind: "changed", trade: trade.view() });
	}

	private closeRequest(request: TradeRequest<P>, reason: RequestCloseReason): void {
		const sent = this.outgoing.get(request.from);
		if (sent?.get(request.to) !== request) {
			return;
		}
		sent.delete(request.to);
		if (sent.isEmpty()) {
			this.outgoing.delete(request.from);
		}

		const incoming = (this.incomingCounts.get(request.to) ?? 1) - 1;
		if (incoming > 0) {
			this.incomingCounts.set(request.to, incoming);
		} else {
			this.incomingCounts.delete(request.to);
		}
		this.emit({ kind: "requestClosed", request, reason });
	}

	private expireRequests(now: number): void {
		const expired = new Array<TradeRequest<P>>();
		for (const [, sent] of this.outgoing) {
			for (const [, request] of sent) {
				if (request.expiresAt <= now) {
					expired.push(request);
				}
			}
		}
		for (const request of expired) {
			this.closeRequest(request, "Expired");
		}
	}

	private endTrade(
		trade: Trade<P>,
		reason: TradeEndReason,
		record?: TradeRecord<P>,
		unreverted?: Transfer<P>[],
	): void {
		if (!this.active.delete(trade)) {
			return;
		}
		for (const player of trade.players) {
			if (this.trades.get(player) === trade) {
				this.trades.delete(player);
			}
		}
		for (const offer of trade.offers) {
			for (const itemId of offer.items) {
				if (this.locks.get(itemId) === trade) {
					this.locks.delete(itemId);
				}
			}
		}
		trade.countdownEndsAt = undefined;
		this.emit({ kind: "ended", trade: trade.view(), reason, record, unreverted });
	}

	private complete(trade: Trade<P>): void {
		const [checked, problem] = pcall(() => this.findProblem(trade));
		if (!checked) {
			this.endTrade(trade, "TransferFailed");
			return;
		} else if (problem !== undefined) {
			this.endTrade(trade, problem);
			return;
		}

		const [first, second] = trade.players;
		const [firstOffer, secondOffer] = trade.offers;
		const transfers = new Array<Transfer<P>>();
		for (const itemId of firstOffer.items) {
			transfers.push({ kind: "item", from: first, to: second, itemId });
		}
		for (const itemId of secondOffer.items) {
			transfers.push({ kind: "item", from: second, to: first, itemId });
		}
		// only the difference changes hands, one transfer instead of two that partly cancel out
		const net = firstOffer.currency - secondOffer.currency;
		if (net > 0) {
			transfers.push({ kind: "currency", from: first, to: second, amount: net });
		} else if (net < 0) {
			transfers.push({ kind: "currency", from: second, to: first, amount: -net });
		}

		const result = transferAll(this.inventory, transfers);
		if (!result.ok) {
			this.endTrade(trade, "TransferFailed", undefined, result.unreverted);
			return;
		}

		const record: TradeRecord<P> = {
			id: trade.id,
			time: this.timestamp(),
			players: trade.players,
			items: [[...firstOffer.items], [...secondOffer.items]],
			currency: [firstOffer.currency, secondOffer.currency],
		};
		this.log.push(record);
		if (this.log.size() > this.logSize) {
			this.log.shift();
		}
		this.endTrade(trade, "Completed", record);
	}

	// everything is checked again at the last moment. offers were valid when made, but items can be
	// spent elsewhere and currency can drop while the countdown runs
	private findProblem(trade: Trade<P>): TradeEndReason | undefined {
		const inventory = this.inventory;
		for (const side of [0, 1] as const) {
			const player = trade.players[side];
			const offer = trade.offers[side];
			for (const itemId of offer.items) {
				if (!inventory.hasItem(player, itemId)) {
					return "ItemMissing";
				}
			}
			if (inventory.getCurrency(player) < offer.currency) {
				return "NotEnoughCurrency";
			}
		}

		if (inventory.canReceive !== undefined) {
			const [first, second] = trade.players;
			const [firstOffer, secondOffer] = trade.offers;
			if (
				!inventory.canReceive(first, secondOffer.items, firstOffer.items) ||
				!inventory.canReceive(second, firstOffer.items, secondOffer.items)
			) {
				return "InventoryFull";
			}
		}
		return undefined;
	}

	private checkBalance(trade: Trade<P>, player: P): void {
		const valueOf = this.valueOf;
		if (valueOf === undefined) {
			return;
		}
		const side = trade.sideOf(player);
		const other = side === 0 ? 1 : 0;
		const given = this.offerValue(trade.offers[side], player, valueOf);
		const received = this.offerValue(trade.offers[other], trade.players[other], valueOf);
		if (given > 0 && given > received * this.imbalanceRatio) {
			this.emit({ kind: "imbalance", trade: trade.view(), player, given, received });
		}
	}

	private offerValue(offer: Offer, owner: P, valueOf: (itemId: string, owner: P) => number): number {
		let total = offer.currency * this.currencyValue;
		for (const itemId of offer.items) {
			total += valueOf(itemId, owner);
		}
		return total;
	}
}
