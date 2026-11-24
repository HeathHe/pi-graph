import { ColorFinderInterface } from "pi-graph-desktop-provider-api";
import { ColorQuery, MatchRequest, MatchResult, Point } from "pi-graph-desktop-shared";
export default class implements ColorFinderInterface {
    findMatch<PROVIDER_DATA_TYPE>(query: MatchRequest<ColorQuery, PROVIDER_DATA_TYPE>): Promise<MatchResult<Point>>;
    findMatches<PROVIDER_DATA_TYPE>(query: MatchRequest<ColorQuery, PROVIDER_DATA_TYPE>): Promise<MatchResult<Point>[]>;
}
