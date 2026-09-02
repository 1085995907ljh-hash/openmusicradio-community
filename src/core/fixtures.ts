import type { Track } from "../shared/contracts";

/**
 * A small, stable catalog for exercising scheduling without provider access.
 * The catalog intentionally contains no provider claims or private user data.
 */
const BASE_FIXTURE_TRACKS: readonly Track[] = [
  {
    id: "fixture-01",
    title: "First Light",
    artist: "North Window",
    durationSeconds: 214,
    energy: 0.32,
    mood: ["calm", "warm"],
    color: "#8FA7B8",
  },
  {
    id: "fixture-02",
    title: "Soft Focus",
    artist: "Paper Planes",
    durationSeconds: 198,
    energy: 0.38,
    mood: ["focused", "steady"],
    color: "#A6B89D",
  },
  {
    id: "fixture-03",
    title: "Open Roads",
    artist: "Signal Fires",
    durationSeconds: 247,
    energy: 0.58,
    mood: ["bright", "forward"],
    color: "#D8A96B",
  },
  {
    id: "fixture-04",
    title: "Blue Hour",
    artist: "North Window",
    durationSeconds: 265,
    energy: 0.27,
    mood: ["quiet", "reflective"],
    color: "#6D7F9C",
  },
  {
    id: "fixture-05",
    title: "Small Signals",
    artist: "Lantern Club",
    durationSeconds: 231,
    energy: 0.46,
    mood: ["curious", "gentle"],
    color: "#B68D72",
  },
  {
    id: "fixture-06",
    title: "High Ground",
    artist: "Signal Fires",
    durationSeconds: 208,
    energy: 0.76,
    mood: ["driving", "confident"],
    color: "#C76C56",
  },
  {
    id: "fixture-07",
    title: "Afterimage",
    artist: "Glass Atlas",
    durationSeconds: 286,
    energy: 0.51,
    mood: ["textured", "dreamy"],
    color: "#8C7AA9",
  },
  {
    id: "fixture-08",
    title: "Side Street",
    artist: "Lantern Club",
    durationSeconds: 219,
    energy: 0.63,
    mood: ["playful", "urban"],
    color: "#B8844D",
  },
  {
    id: "fixture-09",
    title: "Still Water",
    artist: "Moss Radio",
    durationSeconds: 302,
    energy: 0.22,
    mood: ["still", "restful"],
    color: "#719A94",
  },
  {
    id: "fixture-10",
    title: "Pulse Check",
    artist: "Bright Circuit",
    durationSeconds: 192,
    energy: 0.88,
    mood: ["energetic", "precise"],
    color: "#D55C5C",
  },
  {
    id: "fixture-11",
    title: "Common Ground",
    artist: "Paper Planes",
    durationSeconds: 254,
    energy: 0.56,
    mood: ["open", "balanced"],
    color: "#A58D6C",
  },
  {
    id: "fixture-12",
    title: "Night Bus",
    artist: "Moss Radio",
    durationSeconds: 273,
    energy: 0.41,
    mood: ["late", "moving"],
    color: "#607D99",
  },
  {
    id: "fixture-13",
    title: "Daybreak Run",
    artist: "Bright Circuit",
    durationSeconds: 224,
    energy: 0.72,
    mood: ["active", "optimistic"],
    color: "#DA8D51",
  },
  {
    id: "fixture-14",
    title: "Low Tide",
    artist: "Glass Atlas",
    durationSeconds: 307,
    energy: 0.18,
    mood: ["ambient", "soft"],
    color: "#7C9BAA",
  },
  {
    id: "fixture-15",
    title: "Good Company",
    artist: "Sunday Service",
    durationSeconds: 239,
    energy: 0.68,
    mood: ["social", "bright"],
    color: "#C68762",
  },
  {
    id: "fixture-16",
    title: "Last Train Home",
    artist: "Sunday Service",
    durationSeconds: 258,
    energy: 0.34,
    mood: ["closing", "warm"],
    color: "#8A7789",
  },
] satisfies readonly Track[];

const EXTENDED_FIXTURE_TRACKS: readonly Track[] = Array.from({ length: 18 }, (_, index) => {
  const number = index + 17;
  const energies = [0.24, 0.36, 0.48, 0.61, 0.74, 0.83];
  const moods = ["quiet", "focused", "steady", "moving", "bright", "active"];
  return {
    id: `fixture-${number}`,
    title: `Synthetic Carrier ${String(number).padStart(2, "0")}`,
    artist: `Fixture Bank ${String.fromCharCode(65 + (index % 6))}`,
    durationSeconds: 228 + ((index * 17) % 43),
    energy: energies[index % energies.length],
    mood: [moods[index % moods.length], "synthetic"],
    color: ["#78928A", "#8C9A73", "#A48A70", "#7F879C", "#9A766F", "#728B78"][index % 6],
  };
});

export const FIXTURE_TRACKS: readonly Track[] = [
  ...BASE_FIXTURE_TRACKS,
  ...EXTENDED_FIXTURE_TRACKS,
];

export const FIXTURE_LIBRARY = FIXTURE_TRACKS;

export function getFixtureTracks(): Track[] {
  return FIXTURE_TRACKS.map(cloneTrack);
}

export function cloneTrack(track: Track): Track {
  return { ...track, mood: [...track.mood] };
}

export function cloneTracks(tracks: readonly Track[]): Track[] {
  return tracks.map(cloneTrack);
}
