import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearGenUiImageCache, fallbackQueries, findGenUiImage, firstLoadingImage, normalizeImageQuery, pickImage, rankImages } from "./genui-images.js";

const photo = (over: Record<string, unknown> = {}) => ({
  title: "Palolem Beach, Goa",
  creator: "cell105",
  license: "by",
  license_version: "2.0",
  license_url: "https://creativecommons.org/licenses/by/2.0/",
  source: "flickr",
  url: "https://live.staticflickr.com/3270/a_b.jpg",
  thumbnail: "https://api.openverse.org/v1/images/4c1d/thumb/",
  width: 1024,
  height: 768,
  foreign_landing_url: "https://www.flickr.com/photos/76481380@N00/3280042189",
  mature: false,
  tags: [{ name: "beach" }, { name: "india" }],
  ...over,
});

describe("pickImage", () => {
  it("returns the thumbnail with its credit, licence and source page", () => {
    expect(pickImage("palolem beach goa", [photo()])).toEqual({
      src: "https://api.openverse.org/v1/images/4c1d/thumb/",
      width: 1024,
      height: 768,
      title: "Palolem Beach, Goa",
      sourceUrl: "https://www.flickr.com/photos/76481380@N00/3280042189",
      credit: "cell105",
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
    });
  });

  it("would rather show nothing than a picture that does not match the query", () => {
    expect(pickImage("burnt sienna oil paint", [photo({ title: "Pigeons & their Mudhouse", tags: [] })])).toBeNull();
    // Half a match is not enough for a four-word query; title and tags together are.
    expect(pickImage("burnt sienna oil paint", [photo({ title: "Burnt sienna", tags: [{ name: "oil" }] })])?.title).toBe("Burnt sienna");
  });

  it("prefers the closest match, matches plurals, and skips mature or non-https results", () => {
    const results = [
      photo({ title: "Clouds", tags: [] }),
      photo({ title: "Cumulus clouds over the sea", thumbnail: "http://insecure.test/x.jpg", url: "http://insecure.test/x.jpg" }),
      photo({ title: "Cumulus cloud", mature: true }),
      photo({ title: "Big cumulus cloud", thumbnail: "https://api.openverse.org/v1/images/best/thumb/" }),
    ];
    expect(pickImage("cumulus clouds", results)?.src).toBe("https://api.openverse.org/v1/images/best/thumb/");
  });

  it("labels public-domain and CC0 pictures plainly", () => {
    expect(pickImage("palolem beach", [photo({ license: "cc0", license_version: "1.0" })])?.license).toBe("CC0");
    expect(pickImage("palolem beach", [photo({ license: "pdm" })])?.license).toBe("Public domain");
  });
});

describe("firstLoadingImage", () => {
  it("skips a match whose picture does not load and takes the next best", async () => {
    const hits = rankImages("cumulus clouds", [
      photo({ title: "Cumulus clouds", thumbnail: "https://api.openverse.org/v1/images/gone/thumb/" }),
      photo({ title: "Cumulus cloud", thumbnail: "https://api.openverse.org/v1/images/ok/thumb/" }),
    ]);
    expect(hits).toHaveLength(2);
    const check = vi.fn(async (src: string) => !src.includes("/gone/"));
    expect((await firstLoadingImage(hits, check))?.src).toBe("https://api.openverse.org/v1/images/ok/thumb/");
    expect(await firstLoadingImage(hits.slice(0, 1), check)).toBeNull();
  });
});

describe("fallbackQueries", () => {
  it("shortens an over-described query to its leading keywords", () => {
    expect(fallbackQueries("Meenakshi temple gopuram Dravida style")).toEqual(["meenakshi temple gopuram", "meenakshi temple"]);
    expect(fallbackQueries("palolem beach")).toEqual([]);
  });
});

describe("findGenUiImage", () => {
  beforeEach(() => clearGenUiImageCache());

  it("normalizes the query and shares one lookup between concurrent and later callers", async () => {
    const search = vi.fn(async () => ({ src: "https://api.openverse.org/v1/images/x/thumb/" }));
    const [a, b] = await Promise.all([findGenUiImage("  Palolem   Beach ", search), findGenUiImage("palolem beach", search)]);
    expect(a).toEqual(b);
    await findGenUiImage("PALOLEM BEACH", search);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("palolem beach");
    expect(normalizeImageQuery("  Palolem \n Beach ")).toBe("palolem beach");
  });

  it("keeps a found picture for a day but a miss only for ten minutes", async () => {
    vi.useFakeTimers();
    try {
      const search = vi.fn(async (q: string) => (q === "goa" ? { src: "https://api.openverse.org/v1/images/x/thumb/" } : null));
      await findGenUiImage("goa", search);
      await findGenUiImage("nowhere at all", search);
      vi.advanceTimersByTime(11 * 60 * 1000);
      await findGenUiImage("goa", search);
      await findGenUiImage("nowhere at all", search);
      expect(search.mock.calls.map(([q]) => q)).toEqual(["goa", "nowhere at all", "nowhere at all"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a failed lookup", async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error("Openverse answered 429")).mockResolvedValueOnce(null);
    await expect(findGenUiImage("goa", search)).rejects.toThrow("429");
    await expect(findGenUiImage("goa", search)).resolves.toBeNull();
    expect(search).toHaveBeenCalledTimes(2);
  });
});
