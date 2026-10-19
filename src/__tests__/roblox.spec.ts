/// <reference types="@rbxts/testez/globals" />

import { bindTradeService, TradeService } from "..";
import { createHarness, lastEvent, readyBoth, startTrade } from "./support";

export = () => {
	describe("bindTradeService", () => {
		it("finishes countdowns from Heartbeat until unbound", () => {
			const harness = createHarness({ countdown: 0 });
			const { service } = harness;
			harness.inventory.give("alice", ["sword"]);
			startTrade(harness);
			service.addItem("alice", "sword");
			readyBoth(harness);

			// the binding is typed for real players, the string ids stand in for them here
			const unbind = bindTradeService(service as unknown as TradeService<Player>);
			for (let frame = 0; frame < 30 && service.isTrading("alice"); frame++) {
				task.wait();
			}
			unbind();

			expect(service.isTrading("alice")).to.equal(false);
			expect(lastEvent(harness.events, "ended")!.reason).to.equal("Completed");
			expect(harness.inventory.owners.get("sword")).to.equal("bob");
		});
	});
};
