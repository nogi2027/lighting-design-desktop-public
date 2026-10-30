import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir:'./tests/desktop', timeout:240_000, expect:{timeout:Number(process.env.LX_DESKTOP_EXPECT_TIMEOUT ?? 5000)}, workers:1, fullyParallel:false, reporter:[['list'],['json',{outputFile:'artifacts/parity-desktop-results.json'}]], use:{trace:'retain-on-failure',screenshot:'only-on-failure'} });
