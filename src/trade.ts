import { OfferView, TradeView } from "./types";

export interface Offer {
	readonly items: string[];
	currency: number;
	ready: boolean;
}

function viewOffer(offer: Offer): OfferView {
	return { items: [...offer.items], currency: offer.currency, ready: offer.ready };
}

export class Trade<P> {
	public readonly offers: [Offer, Offer] = [
		{ items: [], currency: 0, ready: false },
		{ items: [], currency: 0, ready: false },
	];
	public revision = 0;
	public countdownEndsAt?: number;

	public constructor(
		public readonly id: string,
		public readonly players: readonly [P, P],
		public lastChangeAt: number,
	) {}

	public sideOf(player: P): 0 | 1 {
		return this.players[0] === player ? 0 : 1;
	}

	public offerOf(player: P): Offer {
		return this.offers[this.sideOf(player)];
	}

	public isEmpty(): boolean {
		const [first, second] = this.offers;
		return first.items.isEmpty() && second.items.isEmpty() && first.currency === 0 && second.currency === 0;
	}

	public unready(): void {
		this.offers[0].ready = false;
		this.offers[1].ready = false;
		this.countdownEndsAt = undefined;
	}

	public view(): TradeView<P> {
		return {
			id: this.id,
			players: this.players,
			offers: [viewOffer(this.offers[0]), viewOffer(this.offers[1])],
			revision: this.revision,
			countdownEndsAt: this.countdownEndsAt,
		};
	}
}
