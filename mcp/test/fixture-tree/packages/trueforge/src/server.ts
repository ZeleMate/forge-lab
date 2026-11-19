import { startLoop } from "@truefoundry/trueforge-core/core";
import { thing } from "some-external-package";

export const loop = startLoop();
export const external = thing;
loop.run(1);
