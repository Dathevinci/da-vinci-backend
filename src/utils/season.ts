export const getCurrentSeasonInfo = () => {
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  let season = "WINTER";
  if (month >= 3 && month <= 5) season = "SPRING";
  else if (month >= 6 && month <= 8) season = "SUMMER";
  else if (month >= 9 && month <= 11) season = "FALL";

  let nextSeason = "SPRING";
  let nextYear = year;
  
  if (season === "WINTER") nextSeason = "SPRING";
  if (season === "SPRING") nextSeason = "SUMMER";
  if (season === "SUMMER") nextSeason = "FALL";
  if (season === "FALL") {
    nextSeason = "WINTER";
    nextYear += 1;
  }

  return { season, year, nextSeason, nextYear };
};
