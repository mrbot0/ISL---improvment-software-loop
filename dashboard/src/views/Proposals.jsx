import ProposalList from '../components/ProposalList.jsx';

/** Proposals view: the full-height review queue. Detail opens as a drawer (in App). */
export default function Proposals({ proposals, onOpen, selectedId }) {
  return (
    <div className="h-full">
      <ProposalList proposals={proposals} onOpen={onOpen} selectedId={selectedId} />
    </div>
  );
}
