/// <reference types="@rbxts/testez/globals" />

import { createHarness, Harness, lastEvent, readyBoth, startTrade } from "./support";

// alice puts up a sword and 100 coins, bob puts up a bow, an arrow and 30 coins
function setUpDeal(harness: Harness): void {
	const { service, inventory } = harness;
	inventory.give("alice", ["sword"]);
	inventory.give("bob", ["bow", "arrow"]);
	inventory.balances.set("alice", 250);
	inventory.balances.set("bob", 40);
	startTrade(harness);
	service.addItem("alice", "sword");
	service.setCurrency("alice", 100);
	service.addItem("bob", "bow");
	service.addItem("bob", "arrow");
	service.setCurrency("bob", 30);
}

export = () => {
	function expectUntouched(harness: Harness): void {
		const { inventory } = harness;
		expect(inventory.owners.get("sword")).to.equal("alice");
		expect(inventory.owners.get("bow")).to.equal("bob");
		expect(inventory.owners.get("arrow")).to.equal("bob");
		expect(inventory.getCurrency("alice")).to.equal(250);
		expect(inventory.getCurrency("bob")).to.equal(40);
	}

	describe("completing a trade", () => {
		it("swaps items and the currency difference when the countdown ends", () => {
			const harness = createHarness();
			const { service, inventory, events } = harness;
			setUpDeal(harness);
			readyBoth(harness);

			harness.advance(4.9);
			service.update();
			expect(service.isTrading("alice")).to.equal(true);

			harness.advance(0.1);
			service.update();

			expect(inventory.owners.get("sword")).to.equal("bob");
			expect(inventory.owners.get("bow")).to.equal("alice");
			expect(inventory.owners.get("arrow")).to.equal("alice");
			expect(inventory.getCurrency("alice")).to.equal(180);
			expect(inventory.getCurrency("bob")).to.equal(110);
			expect(inventory.moves).to.equal(4);

			const ended = lastEvent(events, "ended")!;
			expect(ended.reason).to.equal("Completed");
			expect(service.isTrading("alice")).to.equal(false);
			expect(service.isTrading("bob")).to.equal(false);
			expect(service.isLocked("sword")).to.equal(false);
			expect(service.isLocked("bow")).to.equal(false);
		});

		it("writes completed trades to the log", () => {
			const harness = createHarness();
			const { service, events } = harness;
			setUpDeal(harness);
			readyBoth(harness);
			harness.advance(5);
			service.update();

			const record = lastEvent(events, "ended")!.record!;
			expect(record.id).to.equal("trade-1");
			expect(record.time).to.equal(1700000007);
			expect(record.players.join(",")).to.equal("alice,bob");
			expect(record.items[0].join(",")).to.equal("sword");
			expect(record.items[1].join(",")).to.equal("bow,arrow");
			expect(record.currency[0]).to.equal(100);
			expect(record.currency[1]).to.equal(30);
			expect(service.findRecord("trade-1")).to.equal(record);
			expect(service.getLog().size()).to.equal(1);
		});

		it("keeps only the most recent records", () => {
			const harness = createHarness({ logSize: 2, requestCooldown: 0 });
			const { service, inventory } = harness;

			for (let round = 1; round <= 3; round++) {
				inventory.give("alice", [`gem${round}`]);
				startTrade(harness);
				service.addItem("alice", `gem${round}`);
				readyBoth(harness);
				harness.advance(5);
				service.update();
			}

			const log = service.getLog();
			expect(log.size()).to.equal(2);
			expect(log[0].id).to.equal("trade-2");
			expect(log[1].id).to.equal("trade-3");
			expect(service.findRecord("trade-1")).never.to.be.ok();
		});
	});

	describe("countdown", () => {
		it("stops the countdown if either player unreadies", () => {
			const harness = createHarness();
			const { service } = harness;
			setUpDeal(harness);
			readyBoth(harness);

			service.setReady("bob", false);
			expect(service.getTrade("alice")!.countdownEndsAt).never.to.be.ok();
			harness.advance(10);
			service.update();

			expect(service.isTrading("alice")).to.equal(true);
			expectUntouched(harness);
		});

		it("stops the countdown if an offer changes during it", () => {
			const harness = createHarness();
			const { service } = harness;
			setUpDeal(harness);
			readyBoth(harness);

			harness.advance(4);
			service.removeItem("bob", "arrow");
			harness.advance(10);
			service.update();

			expect(service.isTrading("alice")).to.equal(true);
			expectUntouched(harness);
		});

		it("cancels when a player leaves during the countdown", () => {
			const harness = createHarness();
			const { service, events } = harness;
			setUpDeal(harness);
			readyBoth(harness);

			service.playerLeft("bob");
			expect(lastEvent(events, "ended")!.reason).to.equal("PlayerLeft");
			expect(service.isTrading("alice")).to.equal(false);

			harness.advance(5);
			service.update();
			expectUntouched(harness);
		});
	});

	describe("last moment checks", () => {
		it("aborts with nothing moved when an offered item is gone by the end", () => {
			const harness = createHarness();
			const { service, events } = harness;
			setUpDeal(harness);
			readyBoth(harness);

			harness.inventory.owners.delete("arrow");
			harness.advance(5);
			service.update();

			expect(lastEvent(events, "ended")!.reason).to.equal("ItemMissing");
			expect(harness.inventory.moves).to.equal(0);
			expect(harness.inventory.owners.get("sword")).to.equal("alice");
			expect(harness.inventory.getCurrency("alice")).to.equal(250);
			expect(service.isLocked("sword")).to.equal(false);
		});

		it("aborts when a player spent the currency they offered", () => {
			const harness = createHarness();
			setUpDeal(harness);
			readyBoth(harness);

			harness.inventory.balances.set("bob", 10);
			harness.advance(5);
			harness.service.update();

			expect(lastEvent(harness.events, "ended")!.reason).to.equal("NotEnoughCurrency");
			expect(harness.inventory.moves).to.equal(0);
		});

		it("aborts when an inventory can't take what it would receive", () => {
			const harness = createHarness();
			setUpDeal(harness);
			readyBoth(harness);

			// alice has one item and gives it away, two coming in would put her at two
			harness.inventory.capacities.set("alice", 1);
			harness.advance(5);
			harness.service.update();

			expect(lastEvent(harness.events, "ended")!.reason).to.equal("InventoryFull");
			expectUntouched(harness);
		});
	});

	describe("rollback", () => {
		it("rolls everything back when the data layer fails mid swap", () => {
			const harness = createHarness();
			setUpDeal(harness);
			readyBoth(harness);

			harness.inventory.failOnMove = 3;
			harness.advance(5);
			harness.service.update();

			const ended = lastEvent(harness.events, "ended")!;
			expect(ended.reason).to.equal("TransferFailed");
			expect(ended.unreverted!.size()).to.equal(0);
			expectUntouched(harness);
			expect(harness.service.isLocked("sword")).to.equal(false);
			expect(harness.service.getLog().size()).to.equal(0);
		});

		it("rolls back when the data layer throws", () => {
			const harness = createHarness();
			setUpDeal(harness);
			readyBoth(harness);

			harness.inventory.throwOnMove = 4;
			harness.advance(5);
			harness.service.update();

			expect(lastEvent(harness.events, "ended")!.reason).to.equal("TransferFailed");
			expectUntouched(harness);
		});

		it("reports transfers it couldn't reverse", () => {
			const harness = createHarness();
			setUpDeal(harness);
			readyBoth(harness);

			// the first two moves land, then the data layer stops accepting anything, undo included
			harness.inventory.brokenAfter = 2;
			harness.advance(5);
			harness.service.update();

			const ended = lastEvent(harness.events, "ended")!;
			expect(ended.reason).to.equal("TransferFailed");
			const unreverted = ended.unreverted!;
			expect(unreverted.size()).to.equal(2);
			const first = unreverted[0];
			const second = unreverted[1];
			expect(first.kind === "item" && first.itemId).to.equal("bow");
			expect(second.kind === "item" && second.itemId).to.equal("sword");
		});
	});

	describe("value warnings", () => {
		it("warns the player who gives far more than they get back", () => {
			const values: Record<string, number> = { sword: 1000, pebble: 1 };
			const harness = createHarness({ valueOf: (itemId) => values[itemId] ?? 0, imbalanceRatio: 3 });
			const { service, inventory, events } = harness;
			inventory.give("alice", ["sword"]);
			inventory.give("bob", ["pebble"]);
			startTrade(harness);
			service.addItem("alice", "sword");
			service.addItem("bob", "pebble");
			harness.advance(2);

			service.setReady("bob", true);
			expect(lastEvent(events, "imbalance")).never.to.be.ok();

			service.setReady("alice", true);
			const warning = lastEvent(events, "imbalance")!;
			expect(warning.player).to.equal("alice");
			expect(warning.given).to.equal(1000);
			expect(warning.received).to.equal(1);
		});
	});
};
