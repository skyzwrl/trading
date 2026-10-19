// the game's side of a trade. a move that returns false or throws must leave both players untouched,
// that's what makes the rollback in a failed swap exact
export interface TradeInventory<P> {
	hasItem(player: P, itemId: string): boolean;
	getCurrency(player: P): number;
	moveItem(from: P, to: P, itemId: string): boolean;
	moveCurrency(from: P, to: P, amount: number): boolean;
	canReceive?(player: P, incoming: readonly string[], outgoing: readonly string[]): boolean;
}

export type TradeError =
	| "SelfTrade"
	| "Cooldown"
	| "TooManyRequests"
	| "TargetBusy"
	| "AlreadyRequested"
	| "AlreadyTrading"
	| "NoRequest"
	| "NotTrading"
	| "NotOwned"
	| "ItemLocked"
	| "AlreadyOffered"
	| "NotOffered"
	| "OfferFull"
	| "InvalidAmount"
	| "NotEnoughCurrency"
	| "EmptyTrade"
	| "TooSoon"
	| "Stale";

export type TradeResult = { readonly ok: true } | { readonly ok: false; readonly reason: TradeError };

export type RequestCloseReason = "Accepted" | "Declined" | "Cancelled" | "Expired" | "PlayerLeft";

export type TradeEndReason =
	| "Completed"
	| "Cancelled"
	| "PlayerLeft"
	| "StartedAnother"
	| "ItemMissing"
	| "NotEnoughCurrency"
	| "InventoryFull"
	| "TransferFailed";

export interface TradeRequest<P> {
	readonly from: P;
	readonly to: P;
	readonly expiresAt: number;
}

export interface OfferView {
	readonly items: readonly string[];
	readonly currency: number;
	readonly ready: boolean;
}

export interface TradeView<P> {
	readonly id: string;
	readonly players: readonly [P, P];
	readonly offers: readonly [OfferView, OfferView];
	// bumped by every offer change. clients send it back with ready so they confirm the deal they saw
	readonly revision: number;
	readonly countdownEndsAt?: number;
}

export type Transfer<P> =
	| { readonly kind: "item"; readonly from: P; readonly to: P; readonly itemId: string }
	| { readonly kind: "currency"; readonly from: P; readonly to: P; readonly amount: number };

export interface TradeRecord<P> {
	readonly id: string;
	readonly time: number;
	readonly players: readonly [P, P];
	// what each player gave, in the same order as players
	readonly items: readonly [readonly string[], readonly string[]];
	readonly currency: readonly [number, number];
}

export type TradeEvent<P> =
	| { readonly kind: "requested"; readonly request: TradeRequest<P> }
	| { readonly kind: "requestClosed"; readonly request: TradeRequest<P>; readonly reason: RequestCloseReason }
	| { readonly kind: "started"; readonly trade: TradeView<P> }
	| { readonly kind: "changed"; readonly trade: TradeView<P> }
	| {
			readonly kind: "ended";
			readonly trade: TradeView<P>;
			readonly reason: TradeEndReason;
			readonly record?: TradeRecord<P>;
			// moved and then couldn't be moved back. only happens if the data layer breaks during a rollback
			readonly unreverted?: readonly Transfer<P>[];
	  }
	| {
			readonly kind: "imbalance";
			readonly trade: TradeView<P>;
			readonly player: P;
			readonly given: number;
			readonly received: number;
	  };

export interface TradeOptions<P> {
	readonly inventory: TradeInventory<P>;
	readonly requestTimeout?: number;
	readonly requestCooldown?: number;
	readonly maxOutgoingRequests?: number;
	readonly maxIncomingRequests?: number;
	readonly maxItems?: number;
	readonly countdown?: number;
	/** seconds after any offer change before either player can ready up */
	readonly readyDelay?: number;
	readonly logSize?: number;
	readonly valueOf?: (itemId: string, owner: P) => number;
	readonly currencyValue?: number;
	/** warn a player who readies while giving more than this many times what they get back */
	readonly imbalanceRatio?: number;
	readonly clock?: () => number;
	readonly timestamp?: () => number;
	readonly generateId?: () => string;
}
