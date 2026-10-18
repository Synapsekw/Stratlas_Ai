import { EngineeringReview } from '../../../engineer/EngineeringReview';
import './benches.css';

/** The sidebar owns the chrome; review content shares its single scroll surface. */
export function ReviewBench() {
  return (
    <div className="wb-bench wb-scroll" data-testid="review-bench">
      <EngineeringReview />
    </div>
  );
}
