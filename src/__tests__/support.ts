import { TradeEvent, TradeInventory, TradeOptions, TradeResult, TradeService } from "..";

export class FakeInventory implements TradeInventory<string> {
	public readonly owners = new Map<string, string>();
	public readonly balances = new Map<string, number>();
	public readonly capacities = new Map<string, number>();
	public failOnMove?: number;
	public throwOnMove?: number;
	public brokenAfter?: number;
	public moves = 0;

	public give(owner: string, itemIds: string[]): void {
		for (const itemId of itemIds) {
			this.owners.set(itemId, owner);
		}
	}

	public itemCount(player: string): number {
		let total = 0;
		for (const [, owner] of this.owners) {
			if (owner === player) {
				total += 1;
			}
		}
		return total;
	}

	public hasItem(player: string, itemId: string): boolean {
		return this.owners.get(itemId) === player;
	}

	public getCurrency(player: string): number {
		return this.balances.get(player) ?? 0;
	}

	public moveItem(from: string, to: string, itemId: string): boolean {
		if (!this.allowMove() || this.owners.get(itemId) !== from) {
			return false;
		}
		this.owners.set(itemId, to);
		return true;
	}

	public moveCurrency(from: string, to: string, amount: number): boolean {
		if (!this.allowMove() || this.getCurrency(from) < amount) {
			return false;
		}
		this.balances.set(from, this.getCurrency(from) - amount);
		this.balances.set(to, this.getCurrency(to) + amount);
		return true;
	}

	public canReceive(player: string, incoming: readonly string[], outgoing: readonly string[]): boolean {
		const capacity = this.capacities.get(player);
		return capacity === undefined || this.itemCount(player) + incoming.size() - outgoing.size() <= capacity;
	}

	private allowMove(): boolean {
		this.moves += 1;
		if (this.throwOnMove === this.moves) {
			throw "data store request failed";
		}
		if (this.brokenAfter !== undefined && this.moves > this.brokenAfter) {
			return false;
		}
		return this.failOnMove !== this.moves;
	}
}

export interface Harness {
	readonly service: TradeService<string>;
	readonly inventory: FakeInventory;
	readonly events: TradeEvent<string>[];
	readonly advance: (seconds: number) => void;
}

export function createHarness(options: Partial<TradeOptions<string>> = {}): Harness {
	let now = 0;
	let nextId = 0;
	const inventory = new FakeInventory();
	const service = new TradeService<string>({
		inventory,
		clock: () => now,
		timestamp: () => 1700000000 + now,
		generateId: () => {
			nextId += 1;
			return `trade-${nextId}`;
		},
		...options,
	});

	const events = new Array<TradeEvent<string>>();
	service.onEvent((event) => events.push(event));

	return {
		service,
		inventory,
		events,
		advance: (seconds) => {
			now += seconds;
		},
	};
}

export function startTrade(harness: Harness, from = "alice", to = "bob"): void {
	harness.service.request(from, to);
	harness.service.accept(to, from);
}

// waits out the default ready delay first, since every offer change restarts it
export function readyBoth(harness: Harness, first = "alice", second = "bob"): void {
	harness.advance(2);
	harness.service.setReady(first, true);
	harness.service.setReady(second, true);
}

export function kinds(events: TradeEvent<string>[]): string {
	return events.map((event) => event.kind).join(",");
}

export function lastEvent<K extends TradeEvent<string>["kind"]>(
	events: TradeEvent<string>[],
	kind: K,
): Extract<TradeEvent<string>, { kind: K }> | undefined {
	for (let index = events.size() - 1; index >= 0; index--) {
		const event = events[index];
		if (event.kind === kind) {
			return event as Extract<TradeEvent<string>, { kind: K }>;
		}
	}
	return undefined;
}

export function reasonOf(result: TradeResult): string | undefined {
	return result.ok ? undefined : result.reason;
}
